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


def _upload(url: str, data: bytes) -> None:
    """The pre-signed upload URL takes the raw bytes; no token, no form."""
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=300) as res:
        if res.status >= 300:
            raise SlackError("upload", f"http {res.status}")


class Slack:
    def __init__(self, token: str):
        self.token = token
        self._users: list[dict] | None = None
        self._names: dict[str, str] | None = None

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
        if self._names is None:
            self._names = {u["id"]: display_name(u) for u in self.members()}
        return self._names

    def members(self) -> list[dict]:
        # Once per invocation: one users.list is cheaper than users.info per speaker.
        if self._users is None:
            self._users = self.pages("users.list", "members", limit=PAGE)
        return self._users

    def channel(self, given: str) -> str:
        """An id as is; `#name` or `name` looked up, since people say channels by name."""
        if re.fullmatch(r"[CDG][A-Z0-9]+", given):
            return given
        wanted = given.lstrip("#").lower()
        for c in self.pages("conversations.list", "channels", limit=PAGE, exclude_archived="true",
                            types="public_channel,private_channel"):
            if (c.get("name") or "").lower() == wanted:
                return c["id"]
        raise SlackError("channel", f"no channel named #{wanted} — see `channels`")


def display_name(u: dict) -> str:
    p = u.get("profile") or {}
    return p.get("display_name") or u.get("real_name") or u.get("name") or u["id"]


PERMALINK = re.compile(r"https://[\w.-]+\.slack\.com/archives/([A-Z0-9]+)/p(\d{6,})")


def permalink(url: str) -> tuple[str, str, str | None] | None:
    """(channel, ts, thread_ts) from a pasted message link; `p<digits>` is the ts without its dot."""
    m = PERMALINK.match(url)
    if not m:
        return None
    channel, digits = m.group(1), m.group(2)
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    thread = (query.get("thread_ts") or [None])[0]
    return channel, f"{digits[:-6]}.{digits[-6:]}", thread


def target(client: Slack, a: argparse.Namespace, link_is: str = "message") -> None:
    """Resolve `channel` (id, #name or permalink) in place; a permalink also fills `ts`/`thread`.

    `link_is`: what a pasted link stands for — the `message` itself, the `thread`
    it belongs to, or the place a `reply` goes."""
    link = permalink(a.channel)
    if link:
        channel, ts, thread = link
        a.channel = channel
        if link_is == "reply":
            a.thread = a.thread or thread or ts
        elif getattr(a, "ts", None) is None:
            a.ts = (thread or ts) if link_is == "thread" else ts
            if hasattr(a, "thread") and a.thread is None and thread and thread != ts:
                a.thread = thread
    else:
        a.channel = client.channel(a.channel)
    if hasattr(a, "ts") and a.ts is None:
        raise SlackError("ts", "required — a message ts, or a Slack link in place of <channel> <ts>")


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


def body(msg: dict) -> str:
    """The text, or a stand-in for a message whose content is only blocks or attachments."""
    text = msg.get("text") or ""
    if text:
        return text
    titles = [a.get("title") or a.get("fallback") or a.get("text") for a in msg.get("attachments") or []]
    if titles:
        return " ".join(f"[attachment: {t}]" if t else "[attachment]" for t in titles)
    if msg.get("blocks"):
        return "[blocks]"
    return ""


def line(client: Slack, msg: dict, indent: str = "") -> str:
    name, uid = client.name(msg)
    who = f"{name}[{uid}]" if name and name != uid else (f"[{uid}]" if uid else "[unknown]")
    text = body(msg).replace("\n", "\n" + indent + "    ")
    out = f"{indent}{msg['ts']} | {local(msg['ts'])} | {who} | {text}"
    if msg.get("edited"):
        out += " [edited]"
    if msg.get("reply_count") and msg.get("thread_ts", msg["ts"]) == msg["ts"]:
        out += f" [thread: {msg['reply_count']} replies]"
    elif not indent and msg.get("thread_ts") and msg["thread_ts"] != msg["ts"]:
        # A reply also sent to the channel; the same line shows up under its parent.
        out += f" [in thread {msg['thread_ts']}]"
    for f in msg.get("files") or []:
        size = f" {size_label(f['size'])}" if "size" in f else ""
        out += f" [file: {f.get('name') or f.get('mimetype') or 'file'} {f['id']}{size}]"
    if msg.get("reactions"):
        out += " [" + ", ".join(f":{r['name']}: {r.get('count', 1)}" for r in msg["reactions"]) + "]"
    return out


def ordered(messages: list, after: str | None = None) -> list:
    """Oldest first, one per ts (page seams repeat), strictly newer than `after`."""
    by_ts = {m["ts"]: m for m in messages if m.get("ts")}
    out = sorted(by_ts.values(), key=lambda m: float(m["ts"]))
    return [m for m in out if float(m["ts"]) > float(after)] if after else out


def transcript_header(what: str) -> str:
    return f"# {what} — <ts> | <local time {tz_label()}> | <name>[<id>] | <text>; [thread: N replies] marks a parent, [file: name F… size] an upload"


def warn_inert_mention(text: str) -> None:
    """A plain `@alice` looks like it worked and notifies nobody; said, not refused — a name in prose is fine."""
    prose = re.sub(r"```[\s\S]*?```|`[^`]*`|<[^>]*>", "", text)
    hit = re.search(r"(?:^|\s)([@#][A-Za-z][\w.-]*)", prose)
    if not hit:
        return
    word = hit.group(1)
    needs = "<#C…>" if word[0] == "#" else (f"<!{word[1:]}>" if word[1:] in ("here", "channel", "everyone") else "<@U…>")
    print(f"slack: note: {word} is plain text and notified nobody — Slack needs {needs}; edit this ts if it was meant to reach someone", file=sys.stderr)


# --- subcommands -----------------------------------------------------------

def cmd_whoami(client: Slack, _: argparse.Namespace) -> None:
    a = client.api("auth.test")
    print(f"user {a.get('user_id')} bot {a.get('bot_id', '')} team {a.get('team_id')} ({a.get('user')} @ {a.get('team')})")


def cmd_channels(client: Slack, a: argparse.Namespace) -> None:
    convs = client.pages("conversations.list", "channels", limit=PAGE, exclude_archived="true",
                        types="public_channel,private_channel,mpim,im")
    # Channels the bot is in first, DMs last, names alphabetical.
    convs.sort(key=lambda c: (not c.get("is_member", True), bool(c.get("is_im") or c.get("is_mpim")), c.get("name") or ""))
    if a.json:
        return emit_json(convs, a.out, f"{len(convs)} conversations")
    lines = []
    for c in convs:
        if c.get("is_im"):
            kind, name = "dm", client.users().get(c.get("user", ""), c.get("user", ""))
        elif c.get("is_mpim"):
            kind, name = "group-dm", c.get("name", "")
        else:
            kind, name = ("private" if c.get("is_private") else "channel"), f"#{c.get('name', '')}"
        member = "" if c.get("is_member", True) else "  (not a member)"
        lines.append(f"{c['id']}  {kind:9s} {name}{member}")
    emit(lines, a.out, f"{len(convs)} conversations")


def cmd_user(client: Slack, a: argparse.Namespace) -> None:
    if re.fullmatch(r"[UW][A-Z0-9]+", a.who):
        u = client.api("users.info", user=a.who).get("user") or {}
    else:
        wanted = a.who.lstrip("@").lower()
        hits = [u for u in client.members() if wanted in {
            (u.get("profile") or {}).get("display_name", "").lower(), (u.get("real_name") or "").lower(), (u.get("name") or "").lower()}]
        if len(hits) != 1:
            raise SlackError("user", f"{len(hits)} users named {a.who}" + (": " + ", ".join(f"{h['id']} {display_name(h)}" for h in hits) if hits else ""))
        u = hits[0]
    if a.json:
        return emit_json(u, None, "")
    p = u.get("profile") or {}
    bits = [u["id"], display_name(u), f"({u.get('real_name')})" if u.get("real_name") and u.get("real_name") != display_name(u) else "",
            p.get("title") or "", u.get("tz") or "", "bot" if u.get("is_bot") else "", "deleted" if u.get("deleted") else ""]
    print(" ".join(b for b in bits if b))


def cmd_history(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
    after = to_ts(a.after)
    since = after or to_ts(a.since)
    until = to_ts(a.until)
    msgs = ordered(client.pages("conversations.history", "messages", channel=a.channel,
                                oldest=since, latest=until, limit=PAGE, inclusive="true"), after)
    threads = 0
    for m in msgs:
        if a.threads and m.get("reply_count"):
            threads += 1
            replies = ordered(client.pages("conversations.replies", "messages", channel=a.channel, ts=m["ts"], limit=PAGE))
            m["replies"] = [r for r in replies if r["ts"] != m["ts"]]
    summary = f"{len(msgs)} messages" + (f", {threads} threads expanded" if a.threads else "")
    if a.json:
        return emit_json(msgs, a.out, summary)
    lines = [transcript_header(f"{a.channel} {local(since) if since else 'start'} → {local(until) if until else 'now'}")]
    for m in msgs:
        lines.append(line(client, m))
        lines.extend(line(client, r, "  ") for r in m.get("replies", []))
    emit(lines, a.out, summary)


def cmd_thread(client: Slack, a: argparse.Namespace) -> None:
    target(client, a, "thread")
    after = to_ts(a.after)
    msgs = ordered(client.pages("conversations.replies", "messages", channel=a.channel, ts=a.ts,
                                oldest=after, limit=PAGE, inclusive="true"), after)
    if a.json:
        return emit_json(msgs, a.out, f"{len(msgs)} messages")
    emit([transcript_header(f"thread {a.channel}/{a.ts}")] + [line(client, m) for m in msgs], a.out, f"{len(msgs)} messages")


def cmd_message(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
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
    emit_json(found, None, "") if a.json else print(line(client, found))


def cmd_permalink(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
    print(client.api("chat.getPermalink", channel=a.channel, message_ts=a.ts)["permalink"])


def cmd_react(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
    name = a.emoji.strip(":")
    client.api("reactions.add", channel=a.channel, timestamp=a.ts, name=name)
    print(f":{name}: on {a.ts}")


def cmd_upload(client: Slack, a: argparse.Namespace) -> None:
    target(client, a, "reply")
    with open(a.path, "rb") as fh:
        data = fh.read()
    name = os.path.basename(a.path)
    ticket = client.api("files.getUploadURLExternal", filename=name, length=len(data))
    _upload(ticket["upload_url"], data)
    done = client.api("files.completeUploadExternal", files=json.dumps([{"id": ticket["file_id"], "title": name}]),
                      channel_id=a.channel, thread_ts=a.thread, initial_comment=a.comment)
    shared = (done.get("files") or [{}])[0]
    print(f"{shared.get('id', ticket['file_id'])} {name} → {a.channel}" + (f" thread {a.thread}" if a.thread else ""))


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
    target(client, a, "reply")
    text = read_text(a.text)
    sent = send(client, "chat.postMessage", text, channel=a.channel, thread_ts=a.thread,
                unfurl_links="false", unfurl_media="false")
    print(sent.get("ts", ""))
    warn_inert_mention(text)


def cmd_edit(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
    text = read_text(a.text)
    send(client, "chat.update", text, channel=a.channel, ts=a.ts)
    print(a.ts)
    warn_inert_mention(text)


def cmd_delete(client: Slack, a: argparse.Namespace) -> None:
    target(client, a)
    client.api("chat.delete", channel=a.channel, ts=a.ts)
    print(f"deleted {a.ts}")


def emit(lines: list[str], out: str | None, summary: str) -> None:
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"wrote {summary} to {os.path.abspath(out)}")
    else:
        print("\n".join(lines))


def emit_json(data, out: str | None, summary: str) -> None:
    """Raw API objects for a second script to process, so the model never reads them."""
    emit([json.dumps(data, ensure_ascii=False)], out, summary)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="slack.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def cmd(name: str, fn, help: str, *, ts: bool = False, out: bool = False, js: bool = False, thread: str | None = None):
        sp = sub.add_parser(name, help=help)
        sp.add_argument("channel", help="id, #name, or a Slack message link")
        if ts:
            sp.add_argument("ts", nargs="?", help="omit when <channel> is a message link")
        if thread:
            sp.add_argument("--thread", metavar="TS", help=thread)
        if out:
            sp.add_argument("--out", metavar="FILE", help="write to disk, print one summary line")
        if js:
            sp.add_argument("--json", action="store_true", help="raw API JSON instead of transcript lines")
        sp.set_defaults(fn=fn)
        return sp

    sub.add_parser("whoami", help="your own user id").set_defaults(fn=cmd_whoami)
    c = sub.add_parser("channels", help="conversations the bot can reach")
    c.add_argument("--out", metavar="FILE")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_channels)
    u = sub.add_parser("user", help="one user by id or name: id, name, title, tz")
    u.add_argument("who")
    u.add_argument("--json", action="store_true")
    u.set_defaults(fn=cmd_user)
    h = cmd("history", cmd_history, "top-level messages, oldest first", out=True, js=True)
    h.add_argument("--since", metavar="T", help="ISO 8601, epoch seconds or a ts")
    h.add_argument("--until", metavar="T")
    h.add_argument("--after", metavar="TS", help="strictly newer")
    h.add_argument("--threads", action="store_true", help="replies under each parent")
    cmd("thread", cmd_thread, "one thread, oldest first", ts=True, out=True, js=True).add_argument("--after", metavar="TS")
    cmd("message", cmd_message, "one message", ts=True, js=True, thread="its thread_ts, when it is a reply")
    cmd("permalink", cmd_permalink, "a message's link", ts=True)
    f = sub.add_parser("file", help="download an upload by F… id, prints the path")
    f.add_argument("file_id")
    f.add_argument("--dir", default=".")
    f.set_defaults(fn=cmd_file)
    cmd("post", cmd_post, "post markdown (`-` = stdin), prints the ts", thread="reply in this thread").add_argument("text")
    cmd("edit", cmd_edit, "replace a message outright", ts=True).add_argument("text")
    cmd("delete", cmd_delete, "delete a message, no undo", ts=True)
    cmd("react", cmd_react, "add an emoji reaction", ts=True).add_argument("emoji", help="`+1` or `:+1:`")
    up = cmd("upload", cmd_upload, "upload a file, prints its F… id", thread="share into this thread")
    up.add_argument("path")
    up.add_argument("--comment", metavar="TEXT", help="message posted with the file")
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
