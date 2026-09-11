#!/usr/bin/env python3
# Hermetic tests for slack.py: the HTTP function is replaced, nothing reaches
# Slack. Not part of `npm test` (vitest only); run by hand:
#   python3 skills/pier-slack/scripts/test_slack.py
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import slack  # noqa: E402

USERS = {"ok": True, "members": [
    {"id": "U1", "real_name": "Ada Lovelace", "profile": {"display_name": "ada"}},
    {"id": "U2", "real_name": "Bob", "profile": {}},
]}


class FakeSlack:
    """Answers by method; a list answers page by page; `calls` records the form."""

    def __init__(self, answers: dict):
        self.answers = {k: list(v) if isinstance(v, list) else [v] for k, v in answers.items()}
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, form: dict, token: str) -> dict:
        method = url[len(slack.API):]
        self.calls.append((method, dict(form)))
        queue = self.answers.get(method)
        if not queue:
            return {"ok": False, "error": f"unexpected {method}"}
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def run(argv: list[str], fake: FakeSlack, env: dict | None = None) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    environ = {"SLACK_BOT_TOKEN": "xoxb-test"} if env is None else env
    with mock.patch.object(slack, "_post", fake), mock.patch.dict(os.environ, environ, clear=True), \
            mock.patch.object(slack.time, "sleep") as sleep, \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = slack.main(argv)
    fake.slept = [c.args[0] for c in sleep.call_args_list]
    return code, out.getvalue(), err.getvalue()


class Token(unittest.TestCase):
    def test_refuses_without_a_token_and_names_the_incantation(self):
        code, out, err = run(["whoami"], FakeSlack({}), env={})
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN --", err)
        self.assertEqual(err.count("\n"), 1)

    def test_sends_the_token_as_a_bearer_header_only(self):
        fake = FakeSlack({"auth.test": {"ok": True, "user_id": "U9", "bot_id": "B1", "team_id": "T1", "user": "pier", "team": "acme"}})
        code, out, _ = run(["whoami"], fake)
        self.assertEqual(code, 0)
        self.assertEqual(out, "user U9 bot B1 team T1 (pier @ acme)\n")
        self.assertNotIn("token", fake.calls[0][1])


class Time(unittest.TestCase):
    def test_accepts_iso_epoch_and_ts(self):
        self.assertEqual(slack.to_ts("1712.345600"), "1712.345600")
        self.assertEqual(slack.to_ts("1712"), "1712.000000")
        self.assertEqual(slack.to_ts("1970-01-01T00:28:32Z"), "1712.000000")
        self.assertEqual(slack.to_ts("1970-01-01T00:28:32+00:00"), "1712.000000")
        self.assertIsNone(slack.to_ts(None))
        self.assertIsNone(slack.to_ts(""))

    def test_a_naive_iso_time_is_local(self):
        from datetime import datetime
        want = datetime(2024, 6, 1, 12, 0).astimezone().timestamp()
        self.assertEqual(slack.to_ts("2024-06-01T12:00"), f"{want:.6f}")

    def test_refuses_milliseconds_and_nonsense(self):
        with self.assertRaises(slack.SlackError) as e:
            slack.to_ts("1712345600000")
        self.assertIn("epoch seconds, not milliseconds", str(e.exception))
        with self.assertRaises(slack.SlackError):
            slack.to_ts("yesterday")


class Rendering(unittest.TestCase):
    def test_history_renders_names_threads_and_files_oldest_first(self):
        fake = FakeSlack({
            "users.list": USERS,
            "conversations.history": {"ok": True, "messages": [
                {"ts": "1700.000200", "user": "U2", "text": "restarting it"},
                {"ts": "1700.000100", "user": "U1", "text": "the db is on fire", "reply_count": 3,
                 "files": [{"id": "F1", "name": "log.txt", "size": 2048}]},
                {"ts": "1700.000300", "bot_id": "B7", "bot_profile": {"name": "Grafana"}, "text": "FIRING"},
                {"ts": "1700.000400", "user": "U404", "text": "who am i"},
            ]},
        })
        code, out, err = run(["history", "C1"], fake)
        self.assertEqual((code, err), (0, ""))
        header, *lines = out.rstrip("\n").split("\n")
        self.assertTrue(header.startswith("# C1 start → now — <ts> | <local time"))
        t = slack.local
        self.assertEqual(lines, [
            f"1700.000100 | {t('1700.000100')} | ada[U1] | the db is on fire [thread: 3 replies] [file: log.txt F1 2KB]",
            f"1700.000200 | {t('1700.000200')} | Bob[U2] | restarting it",
            f"1700.000300 | {t('1700.000300')} | Grafana[B7] | FIRING",
            f"1700.000400 | {t('1700.000400')} | [U404] | who am i",
        ])
        # One users.list per invocation, never users.info.
        self.assertEqual([m for m, _ in fake.calls if m.startswith("users")], ["users.list"])

    def test_a_reply_is_not_marked_as_a_thread_parent(self):
        msg = {"ts": "1700.000200", "thread_ts": "1700.000100", "user": "U1", "text": "hi", "reply_count": 0}
        self.assertNotIn("[thread", slack.line(slack.Slack("t"), msg | {"user": None, "bot_id": "B1"}))

    def test_history_expands_threads_under_their_parent(self):
        fake = FakeSlack({
            "users.list": USERS,
            "conversations.history": {"ok": True, "messages": [
                {"ts": "1700.000100", "user": "U1", "text": "parent", "reply_count": 1},
                {"ts": "1700.000900", "user": "U2", "text": "later"},
            ]},
            "conversations.replies": {"ok": True, "messages": [
                {"ts": "1700.000100", "user": "U1", "text": "parent", "reply_count": 1},
                {"ts": "1700.000150", "user": "U2", "thread_ts": "1700.000100", "text": "child\nsecond line"},
            ]},
        })
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.txt")
            code, out, _ = run(["history", "C1", "--threads", "--out", path], fake)
            self.assertEqual(code, 0)
            self.assertEqual(out, f"wrote 2 messages, 1 threads expanded to {path}\n")
            lines = open(path, encoding="utf-8").read().split("\n")
        self.assertIn("| ada[U1] | parent [thread: 1 replies]", lines[1])
        self.assertTrue(lines[2].startswith("  1700.000150 |"))
        self.assertEqual(lines[3], "      second line")
        self.assertIn("| Bob[U2] | later", lines[4])
        self.assertEqual([m for m, _ in fake.calls if m == "conversations.replies"], ["conversations.replies"])

    def test_since_until_after_reach_slack_as_ts_and_after_is_strict(self):
        fake = FakeSlack({
            "users.list": USERS,
            "conversations.history": {"ok": True, "messages": [
                {"ts": "1700.000100", "user": "U1", "text": "boundary"},
                {"ts": "1700.000200", "user": "U1", "text": "newer"},
            ]},
        })
        code, out, _ = run(["history", "C1", "--after", "1700.000100", "--until", "1970-01-01T00:28:32Z"], fake)
        self.assertEqual(code, 0)
        form = fake.calls[0][1]
        self.assertEqual((form["oldest"], form["latest"], form["inclusive"]), ("1700.000100", "1712.000000", "true"))
        self.assertNotIn("boundary", out)
        self.assertIn("newer", out)

    def test_thread_and_message(self):
        replies = {"ok": True, "messages": [
            {"ts": "1700.000100", "user": "U1", "text": "parent", "reply_count": 2},
            {"ts": "1700.000200", "user": "U2", "thread_ts": "1700.000100", "text": "one"},
            {"ts": "1700.000300", "user": "U2", "thread_ts": "1700.000100", "text": "two"},
        ]}
        fake = FakeSlack({"users.list": USERS, "conversations.replies": replies})
        code, out, _ = run(["thread", "C1", "1700.000100", "--after", "1700.000100"], fake)
        self.assertEqual(code, 0)
        body = out.split("\n")[1:-1]
        self.assertEqual(len(body), 2)
        self.assertIn("| one", body[0])
        # A reply is found through its thread when history cannot see it.
        fake = FakeSlack({"users.list": USERS, "conversations.history": {"ok": True, "messages": []},
                          "conversations.replies": {"ok": True, "messages": replies["messages"][1:2]}})
        code, out, _ = run(["message", "C1", "1700.000200"], fake)
        self.assertEqual(code, 0)
        self.assertIn("| Bob[U2] | one", out)
        self.assertEqual([m for m, _ in fake.calls if m.startswith("conversations")],
                         ["conversations.history", "conversations.replies"])

    def test_channels_lists_id_kind_and_name(self):
        fake = FakeSlack({
            "users.list": USERS,
            "conversations.list": [
                {"ok": True, "channels": [{"id": "C1", "name": "dev", "is_member": True}],
                 "response_metadata": {"next_cursor": "c2"}},
                {"ok": True, "channels": [
                    {"id": "D1", "is_im": True, "user": "U1"},
                    {"id": "C2", "name": "ops", "is_private": True, "is_member": False},
                ]},
            ],
        })
        code, out, _ = run(["channels"], fake)
        self.assertEqual(code, 0)
        self.assertEqual(out.split("\n")[:-1], [
            "C1  channel   #dev",
            "D1  dm        ada",
            "C2  private   #ops  (not a member)",
        ])
        self.assertEqual(fake.calls[1][1]["cursor"], "c2")


class Pagination(unittest.TestCase):
    def test_walks_every_page_and_dedups_the_seam(self):
        fake = FakeSlack({
            "users.list": USERS,
            "conversations.history": [
                {"ok": True, "messages": [{"ts": "1700.000300", "user": "U1", "text": "c"},
                                          {"ts": "1700.000200", "user": "U1", "text": "b"}],
                 "response_metadata": {"next_cursor": "p2"}},
                {"ok": True, "messages": [{"ts": "1700.000200", "user": "U1", "text": "b"},
                                          {"ts": "1700.000100", "user": "U1", "text": "a"}],
                 "response_metadata": {"next_cursor": ""}},
            ],
        })
        code, out, _ = run(["history", "C1"], fake)
        self.assertEqual(code, 0)
        texts = [l.split(" | ")[-1] for l in out.rstrip("\n").split("\n")[1:]]
        self.assertEqual(texts, ["a", "b", "c"])
        cursors = [f.get("cursor") for m, f in fake.calls if m == "conversations.history"]
        self.assertEqual(cursors, [None, "p2"])


class RateLimit(unittest.TestCase):
    def test_honours_retry_after_then_succeeds(self):
        fake = FakeSlack({"auth.test": [
            slack.RateLimited(7),
            {"ok": False, "error": "ratelimited"},
            {"ok": True, "user_id": "U9", "team_id": "T1", "user": "pier", "team": "acme"},
        ]})
        code, out, _ = run(["whoami"], fake)
        self.assertEqual(code, 0)
        self.assertIn("user U9", out)
        self.assertEqual(fake.slept, [7, 5])

    def test_gives_up_after_bounded_retries(self):
        fake = FakeSlack({"auth.test": slack.RateLimited(1)})
        code, out, err = run(["whoami"], fake)
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(err, "slack: auth.test: ratelimited after retries\n")
        self.assertEqual(len(fake.slept), slack.RETRIES)


class Errors(unittest.TestCase):
    def test_slack_error_is_one_line_verbatim(self):
        fake = FakeSlack({"conversations.history": {"ok": False, "error": "not_in_channel"}})
        code, out, err = run(["history", "C1"], fake)
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(err, "slack: conversations.history: not_in_channel\n")

    def test_missing_message_says_how_to_find_a_reply(self):
        fake = FakeSlack({"conversations.history": {"ok": True, "messages": []},
                          "conversations.replies": {"ok": False, "error": "thread_not_found"}})
        code, _, err = run(["message", "C1", "1700.000200"], fake)
        self.assertEqual(code, 1)
        self.assertEqual(err, "slack: conversations.replies: thread_not_found\n")


class Writes(unittest.TestCase):
    def test_post_uses_the_markdown_block_and_prints_the_ts(self):
        fake = FakeSlack({"chat.postMessage": {"ok": True, "ts": "1700.000500"}})
        code, out, _ = run(["post", "C1", "**hi** <@U1>", "--thread", "1700.000100"], fake)
        self.assertEqual((code, out), (0, "1700.000500\n"))
        form = fake.calls[0][1]
        self.assertEqual((form["channel"], form["thread_ts"], form["text"]), ("C1", "1700.000100", "**hi** <@U1>"))
        self.assertIn('"type": "markdown"', form["blocks"])
        self.assertEqual(form["unfurl_links"], "false")

    def test_post_falls_back_to_plain_text_where_the_block_is_refused(self):
        fake = FakeSlack({"chat.postMessage": [{"ok": False, "error": "invalid_blocks"}, {"ok": True, "ts": "1"}]})
        code, out, _ = run(["post", "C1", "hi"], fake)
        self.assertEqual((code, out), (0, "1\n"))
        self.assertNotIn("blocks", fake.calls[1][1])
        # `None` never reaches the wire: _post drops it before encoding.
        self.assertIsNone(fake.calls[1][1]["thread_ts"])

    def test_post_reads_stdin_and_refuses_empty_or_oversized_text(self):
        fake = FakeSlack({"chat.postMessage": {"ok": True, "ts": "2"}})
        with mock.patch.object(sys, "stdin", io.StringIO("from stdin\n")):
            code, out, _ = run(["post", "C1", "-"], fake)
        self.assertEqual((code, out), (0, "2\n"))
        self.assertEqual(fake.calls[0][1]["text"], "from stdin\n")
        code, _, err = run(["post", "C1", "  "], fake)
        self.assertEqual((code, err), (1, "slack: text: empty\n"))
        code, _, err = run(["post", "C1", "x" * (slack.TEXT_MAX + 1)], fake)
        self.assertEqual(code, 1)
        self.assertIn("split it across replies", err)

    def test_edit_and_delete_pass_slacks_refusal_through(self):
        fake = FakeSlack({"chat.update": {"ok": True}, "chat.delete": {"ok": False, "error": "cant_delete_message"}})
        code, out, _ = run(["edit", "C1", "1700.000500", "new text"], fake)
        self.assertEqual((code, out), (0, "1700.000500\n"))
        self.assertEqual(fake.calls[0][1]["ts"], "1700.000500")
        self.assertNotIn("thread_ts", fake.calls[0][1])
        code, _, err = run(["delete", "C1", "1700.000500"], fake)
        self.assertEqual((code, err), (1, "slack: chat.delete: cant_delete_message\n"))


class Files(unittest.TestCase):
    def test_downloads_by_id_into_dir_and_prints_the_path(self):
        fake = FakeSlack({"files.info": {"ok": True, "file": {
            "id": "F1", "name": "post mortem.pdf", "url_private_download": "https://files.slack.com/x"}}})
        with tempfile.TemporaryDirectory() as d, mock.patch.object(slack, "_download", return_value=b"%PDF") as dl:
            code, out, err = run(["file", "F1", "--dir", d], fake)
            self.assertEqual((code, err), (0, ""))
            path = out.strip()
            self.assertEqual(path, os.path.join(d, "F1-post_mortem.pdf"))
            self.assertEqual(open(path, "rb").read(), b"%PDF")
            self.assertEqual(dl.call_args.args, ("https://files.slack.com/x", "xoxb-test"))


if __name__ == "__main__":
    unittest.main()
