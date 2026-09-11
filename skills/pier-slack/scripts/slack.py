#!/usr/bin/env python3
"""slack.py — read and write Slack from a shell, token from the environment.

Run through Pier's vault so the token never enters a model's context:
  pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- slack.py <subcommand> …

Stdlib only. Every failure is one line on stderr and a non-zero exit, with
Slack's own `error` code verbatim.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://slack.com/api/"
RETRIES = 5
# Epoch seconds at the year 2100: past this, the caller meant milliseconds,
# and Slack would answer an empty read indistinguishable from a quiet channel.
MAX_SECONDS = 4_102_444_800
# Slack's `markdown` block takes 12,000; the margin covers what a renderer adds.
TEXT_MAX = 11_000
PAGE = 200


class SlackError(Exception):
    """One line for stderr; `code` is Slack's error field when it has one."""

    def __init__(self, where: str, code: str):
        super().__init__(f"{where}: {code}")
        self.code = code


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        super().__init__("ratelimited")
        self.retry_after = retry_after


def _post(url: str, form: dict, token: str) -> dict:
    """The one HTTP call every Web API method goes through; tests replace it."""
    body = urllib.parse.urlencode({k: v for k, v in form.items() if v is not None}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/x-www-form-urlencoded",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RateLimited(float(e.headers.get("Retry-After", "5"))) from None
        raise SlackError(url, f"http {e.code}") from None


def _download(url: str, token: str) -> bytes:
    """File hosts want the token as a bearer header and answer a login page without it."""
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=300) as res:
        return res.read()


class Slack:
    def __init__(self, token: str):
        self.token = token
        self._users: dict[str, str] | None = None

    def api(self, method: str, **params) -> dict:
        for attempt in range(RETRIES):
            try:
                data = _post(API + method, params, self.token)
            except RateLimited as e:
                time.sleep(min(e.retry_after, 60))
                continue
            if data.get("ok"):
                return data
            if data.get("error") == "ratelimited" and attempt < RETRIES - 1:
                time.sleep(5)
                continue
            raise SlackError(method, str(data.get("error", "unknown")))
        raise SlackError(method, "ratelimited after retries")

    def pages(self, method: str, key: str, **params) -> list:
        """Every page of a cursor-paginated list."""
        out, cursor = [], None
        while True:
            data = self.api(method, cursor=cursor, **params)
            out.extend(data.get(key, []))
            cursor = data.get("response_metadata", {}).get("next_cursor") or None
            if not cursor:
                return out

    def name(self, msg: dict) -> tuple[str, str]:
        """(display name, id) for a message's author; the id alone when unknown."""
        uid = msg.get("user") or msg.get("bot_id") or ""
        if not uid:
            return "", ""
        if msg.get("user"):
            return self.users().get(uid, uid), uid
        return (msg.get("bot_profile") or {}).get("name") or msg.get("username") or uid, uid

    def users(self) -> dict[str, str]:
        # Once per invocation: one users.list is cheaper than users.info per speaker.
        if self._users is None:
            self._users = {}
            for u in self.pages("users.list", "members", limit=PAGE):
                p = u.get("profile") or {}
                self._users[u["id"]] = p.get("display_name") or u.get("real_name") or u.get("name") or u["id"]
        return self._users


# --- time ------------------------------------------------------------------

def to_ts(value: str | None) -> str | None:
    """ISO 8601 (naive = local), epoch seconds, or a Slack ts → a Slack ts."""
    if value is None or value == "":
        return None
    raw = value.strip()
    if re.fullmatch(r"\d+(\.\d+)?", raw):
        seconds = float(raw)
    else:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            raise SlackError("time", f"not a time: {value}") from None
        seconds = dt.astimezone().timestamp() if dt.tzinfo is None else dt.timestamp()
    if seconds > MAX_SECONDS:
        raise SlackError("time", f"{value} is past the year 2100 — Slack times are epoch seconds, not milliseconds")
    # A ts is an id as well as a time: never rewritten.
    return raw if re.fullmatch(r"\d+\.\d+", raw) else f"{seconds:.6f}"


def local(ts: str) -> str:
    return datetime.fromtimestamp(float(ts)).astimezone().strftime("%Y-%m-%d %H:%M")


def tz_label() -> str:
    return datetime.now().astimezone().strftime("%z")


# --- rendering -------------------------------------------------------------

def size_label(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{round(n / 1024)}KB"
    return f"{n / (1024 * 1024):.1f}MB"


def line(client: Slack, msg: dict, indent: str = "") -> str:
    name, uid = client.name(msg)
    who = f"{name}[{uid}]" if name and name != uid else (f"[{uid}]" if uid else "[unknown]")
    text = (msg.get("text") or "").replace("\n", "\n" + indent + "    ")
    out = f"{indent}{msg['ts']} | {local(msg['ts'])} | {who} | {text}"
    if msg.get("reply_count") and msg.get("thread_ts", msg["ts"]) == msg["ts"]:
        out += f" [thread: {msg['reply_count']} replies]"
    for f in msg.get("files") or []:
        size = f" {size_label(f['size'])}" if "size" in f else ""
        out += f" [file: {f.get('name') or f.get('mimetype') or 'file'} {f['id']}{size}]"
    return out


def ordered(messages: list, after: str | None = None) -> list:
    """Oldest first, one per ts (page seams repeat), strictly newer than `after`."""
    by_ts = {m["ts"]: m for m in messages if m.get("ts")}
    out = sorted(by_ts.values(), key=lambda m: float(m["ts"]))
    return [m for m in out if float(m["ts"]) > float(after)] if after else out


def transcript_header(what: str) -> str:
    return f"# {what} — <ts> | <local time {tz_label()}> | <name>[<id>] | <text>; [thread: N replies] marks a parent, [file: name F… size] an upload"


# --- subcommands -----------------------------------------------------------

def cmd_whoami(client: Slack, _: argparse.Namespace) -> None:
    a = client.api("auth.test")
    print(f"user {a.get('user_id')} bot {a.get('bot_id', '')} team {a.get('team_id')} ({a.get('user')} @ {a.get('team')})")


def cmd_channels(client: Slack, _: argparse.Namespace) -> None:
    convs = client.pages("conversations.list", "channels", limit=PAGE, exclude_archived="true",
                         types="public_channel,private_channel,mpim,im")
    # Channels the bot is in first, DMs last, names alphabetical.
    for c in sorted(convs, key=lambda c: (not c.get("is_member", True), bool(c.get("is_im") or c.get("is_mpim")), c.get("name") or "")):
        if c.get("is_im"):
            kind, name = "dm", client.users().get(c.get("user", ""), c.get("user", ""))
        elif c.get("is_mpim"):
            kind, name = "group-dm", c.get("name", "")
        else:
            kind, name = ("private" if c.get("is_private") else "channel"), f"#{c.get('name', '')}"
        member = "" if c.get("is_member", True) else "  (not a member)"
        print(f"{c['id']}  {kind:9s} {name}{member}")


def cmd_history(client: Slack, a: argparse.Namespace) -> None:
    after = to_ts(a.after)
    since = after or to_ts(a.since)
    until = to_ts(a.until)
    msgs = ordered(client.pages("conversations.history", "messages", channel=a.channel,
                                oldest=since, latest=until, limit=PAGE, inclusive="true"), after)
    lines = [transcript_header(f"{a.channel} {local(since) if since else 'start'} → {local(until) if until else 'now'}")]
    threads = 0
    for m in msgs:
        lines.append(line(client, m))
        if a.threads and m.get("reply_count"):
            threads += 1
            replies = ordered(client.pages("conversations.replies", "messages", channel=a.channel, ts=m["ts"], limit=PAGE))
            lines.extend(line(client, r, "  ") for r in replies if r["ts"] != m["ts"])
    emit(lines, a.out, f"{len(msgs)} messages" + (f", {threads} threads expanded" if a.threads else ""))


def cmd_thread(client: Slack, a: argparse.Namespace) -> None:
    after = to_ts(a.after)
    msgs = ordered(client.pages("conversations.replies", "messages", channel=a.channel, ts=a.ts,
                                oldest=after, limit=PAGE, inclusive="true"), after)
    emit([transcript_header(f"thread {a.channel}/{a.ts}")] + [line(client, m) for m in msgs], a.out, f"{len(msgs)} messages")


def cmd_message(client: Slack, a: argparse.Namespace) -> None:
    # A reply lives only in its thread: history cannot see it, replies can.
    if a.thread:
        page = client.api("conversations.replies", channel=a.channel, ts=a.thread, oldest=a.ts, inclusive="true", limit=20)
    else:
        page = client.api("conversations.history", channel=a.channel, oldest=a.ts, latest=a.ts, inclusive="true", limit=1)
    found = next((m for m in page.get("messages", []) if m.get("ts") == a.ts), None)
    if found is None and not a.thread:
        page = client.api("conversations.replies", channel=a.channel, ts=a.ts, limit=1)
        found = next((m for m in page.get("messages", []) if m.get("ts") == a.ts), None)
    if found is None:
        raise SlackError("message", f"no message {a.ts} in {a.channel}" + ("" if a.thread else " — a reply inside a thread may need --thread"))
    print(line(client, found))


def cmd_file(client: Slack, a: argparse.Namespace) -> None:
    f = client.api("files.info", file=a.file_id).get("file") or {}
    url = f.get("url_private_download") or f.get("url_private")
    if not url:
        raise SlackError("files.info", "no private url")
    name = re.sub(r"[^\w.\-]+", "_", f.get("name") or a.file_id).strip("._") or a.file_id
    os.makedirs(a.dir, exist_ok=True)
    path = os.path.abspath(os.path.join(a.dir, f"{a.file_id}-{name}"))
    with open(path, "wb") as out:
        out.write(_download(url, client.token))
    print(path)


def read_text(arg: str) -> str:
    text = sys.stdin.read() if arg == "-" else arg
    if not text.strip():
        raise SlackError("text", "empty")
    if len(text) > TEXT_MAX:
        raise SlackError("text", f"{len(text)} chars; Slack takes {TEXT_MAX} per message — split it across replies")
    return text


def send(client: Slack, method: str, text: str, **params) -> dict:
    """Slack's own markdown renderer; a workspace that predates the block gets mrkdwn."""
    try:
        return client.api(method, text=text, blocks=json.dumps([{"type": "markdown", "text": text}]), **params)
    except SlackError as e:
        if e.code not in ("invalid_blocks", "unsupported_block_type"):
            raise
        return client.api(method, text=text, **params)


def cmd_post(client: Slack, a: argparse.Namespace) -> None:
    sent = send(client, "chat.postMessage", read_text(a.text), channel=a.channel, thread_ts=a.thread,
                unfurl_links="false", unfurl_media="false")
    print(sent.get("ts", ""))


def cmd_edit(client: Slack, a: argparse.Namespace) -> None:
    send(client, "chat.update", read_text(a.text), channel=a.channel, ts=a.ts)
    print(a.ts)


def cmd_delete(client: Slack, a: argparse.Namespace) -> None:
    client.api("chat.delete", channel=a.channel, ts=a.ts)
    print(f"deleted {a.ts}")


def emit(lines: list[str], out: str | None, summary: str) -> None:
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"wrote {summary} to {os.path.abspath(out)}")
    else:
        print("\n".join(lines))


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="slack.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami", help="auth.test: your own user id, so you can tell your messages apart").set_defaults(fn=cmd_whoami)
    sub.add_parser("channels", help="conversations the bot can reach: id, kind, name").set_defaults(fn=cmd_channels)
    h = sub.add_parser("history", help="a channel's top-level messages, oldest first")
    h.add_argument("channel")
    h.add_argument("--since", help="ISO 8601, epoch seconds or a ts")
    h.add_argument("--until")
    h.add_argument("--after", help="strictly newer than this ts")
    h.add_argument("--threads", action="store_true", help="expand each thread's replies under its parent")
    h.add_argument("--out", help="write the transcript here and print one summary line")
    h.set_defaults(fn=cmd_history)
    t = sub.add_parser("thread", help="one thread, oldest first")
    t.add_argument("channel")
    t.add_argument("ts")
    t.add_argument("--after", help="strictly newer than this ts")
    t.add_argument("--out")
    t.set_defaults(fn=cmd_thread)
    m = sub.add_parser("message", help="one message")
    m.add_argument("channel")
    m.add_argument("ts")
    m.add_argument("--thread", help="the thread_ts, when the message is a reply")
    m.set_defaults(fn=cmd_message)
    f = sub.add_parser("file", help="download a file by its F… id, prints the path")
    f.add_argument("file_id")
    f.add_argument("--dir", default=".")
    f.set_defaults(fn=cmd_file)
    po = sub.add_parser("post", help="post markdown; `-` reads stdin; prints the ts")
    po.add_argument("channel")
    po.add_argument("text")
    po.add_argument("--thread", help="reply in this thread")
    po.set_defaults(fn=cmd_post)
    e = sub.add_parser("edit", help="replace a message you posted")
    e.add_argument("channel")
    e.add_argument("ts")
    e.add_argument("text")
    e.set_defaults(fn=cmd_edit)
    d = sub.add_parser("delete", help="delete a message you posted")
    d.add_argument("channel")
    d.add_argument("ts")
    d.set_defaults(fn=cmd_delete)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("slack: SLACK_BOT_TOKEN is not set — run: pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- slack.py …", file=sys.stderr)
        return 2
    try:
        args.fn(Slack(token), args)
    except SlackError as e:
        print(f"slack: {e}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError) as e:
        print(f"slack: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
