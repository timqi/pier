---
name: pier-slack
description: Read and write Slack from the shell with this skill's script and a vault token — history, threads, files, post/edit/delete — plus the Slack-specific syntax for mentions and links. Read before answering questions about Slack conversations or posting anything to a workspace.
---

# Slack from the shell

There is no Slack tool. Every operation is `scripts/slack.py` (relative to this
file's directory), run with the bot token injected by Pier's vault:

```
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- <skill dir>/scripts/slack.py <subcommand> …
```

Stdlib Python 3, no install. The token never prints and never enters your
context; a `vault:` line on stderr means the secret is missing or locked —
follow the pier-vault skill, never work around it.

## Where you are

The first message of a Slack session opens with a header like
`[Dana<U7> 2024-06-01 14:23 slack:C079TC7GUBG/1712.345600]`:
`slack:<channel>/<thread_ts>` is this conversation. It is said once; it does
not change. A session without that token (web, task, subagent) is not in
Slack — name a channel explicitly.

## Subcommands

| Command | Does |
| --- | --- |
| `whoami` | your bot's user id and team — the id your own messages carry |
| `channels` | every conversation the bot can reach: `id kind name`, non-members marked |
| `history <channel> [--since T] [--until T] [--after TS] [--threads] [--out FILE]` | top-level messages, oldest first, all pages; `--threads` expands replies under each parent; `--out` writes to disk and prints one summary line |
| `thread <channel> <ts> [--after TS] [--out FILE]` | one thread, oldest first |
| `message <channel> <ts> [--thread TS]` | one message; a reply inside a thread is found through its thread |
| `file <F…id> [--dir DIR]` | download an upload by id, prints the path (default: cwd) |
| `post <channel> <text \| -> [--thread TS]` | post markdown, prints the `ts`; `-` reads stdin |
| `edit <channel> <ts> <text \| ->` | replace a message outright |
| `delete <channel> <ts>` | delete a message — no undo |

- Times (`--since`, `--until`, `--after`): ISO 8601 (naive = local), epoch
  seconds, or a Slack `ts`. `--after` is strictly newer — re-read without
  seeing what you already saw.
- A transcript line is `<ts> | <local time> | <name>[<id>] | <text>`, then
  `[thread: N replies]` on a parent and `[file: <name> <F…> <size>]` per
  upload; the first line names the format and the timezone. The `ts` is the
  id: pass it back to `thread`, `message`, `--after`, `edit`, `delete`.
- A wide range belongs on disk: `history … --threads --out raw.txt`, then
  read the file in pieces. Never page a week through your context.
- Text that starts with `-`, or is long: pipe it, `… post C1 - <<'EOF'`.
- 11,000 chars per message; longer is refused. Split across replies in one
  thread rather than truncating.
- Errors are one `slack: <method>: <error>` line, Slack's code verbatim:
  `not_in_channel` → someone must `/invite` the bot; `missing_scope` → the
  operator reinstalls the app; `cant_update_message` / `cant_delete_message`
  → not your message.

## Markdown is not Slack syntax

`text` is **standard markdown** and Slack renders it natively: `**bold**`,
`_italic_`, `` `code` ``, fences, headings, lists, tables, blockquotes. Never
hand-convert to the older mrkdwn `*bold*` — it renders literally.

Four things markdown cannot express:

| Intent | Write | Not |
| --- | --- | --- |
| Mention a person | `<@U04B7Q2>` | `@alice` — plain text, pings nobody |
| Link a channel | `<#C0123456>` | `#general` — plain text |
| Notify the channel | `<!here>`, `<!channel>` | `@here` — plain text |
| Hyperlink | `[label](https://…)` | — |

- **Never guess an id from a name.** A wrong `<@U…>` fails or pings a stranger,
  and both look like it worked. With no id, write the person's name as prose.
- **You already have the ids** — the `name<id>` header on the message you are
  answering, `name[id]` on every transcript line. Asking a human to paste their
  own user id is never acceptable.
- Escape `&` `<` `>` when they are text, not markup: `&amp;` `&lt;` `&gt;`.
- Emoji as `:white_check_mark:`, not the raw glyph.

## Rules

- Read before you write. A summary of the wrong thread is worse than none.
- **Reply in the thread you were reached in** (`--thread` with the header's
  `thread_ts`); a channel's main flow is wider than the conversation, so a
  top-level post is a deliberate choice, said out loud.
- **Edit and delete only what you posted.** Nothing stops the command; Slack
  refuses other people's messages, and a bot's own it does not. `whoami` tells
  you which id is yours; a transcript line shows who posted each `ts`.
- `edit` replaces the text outright; read the message first if you are
  changing part of it. Slack keeps no version a reader can open, so when the
  previous wording mattered, say what changed. A running status is better as
  one message edited in place than one message per change.
- `delete` cannot be undone, and deleting a parent leaves its replies. Say
  what you removed; a message vanishing with no word looks like a bug.
- **In a busy thread, say nothing unless you are needed.** You are handed
  every message, including humans talking to each other; `<silent>why</silent>`
  sends nothing at all.
- Never post credentials, tokens or file contents you were not asked to share:
  a channel is usually wider than the conversation you are in.
- A `ts` means nothing outside the conversation it was read in; `edit` and
  `delete` always take it explicitly.
