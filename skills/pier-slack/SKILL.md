---
name: pier-slack
description: Slack from the shell with `pier slack` — history, threads, post, edit, files — and Slack's mention syntax. Read before reading or posting to Slack.
---

# Slack from the shell

Every operation is `pier slack <subcommand> …`; there is no Slack tool. The
bot token comes from Pier's vault, never from you; an `approve`-level token
may pause the command until the operator approves. A `vault:` line on stderr
is the pier-vault skill's.

Where you are: the first speaker header ends `slack:<channel>/<thread_ts>`,
said once; without it name a channel explicitly.

## Subcommands

| Command | Does |
| --- | --- |
| `whoami` | your bot's id |
| `channels [--out F] [--json]` | `<id> #name`, `· private`, `· not a member`, `<id> dm <name>` |
| `user <id \| @name> [--json]` | id, name, title, tz |
| `history <ch> [--since T --until T --after TS --threads --ts --ids --out F --json]` | top-level, oldest first, all pages; `--threads` nests replies |
| `thread <ch> <ts> [--after TS --ts --ids --out F --json]` | one thread |
| `message <ch> <ts> [--thread TS] [--json]` | one message; a reply needs its thread |
| `permalink <ch> <ts>` | link |
| `file <F…> [--dir D]` | download an upload, prints the path |
| `upload <ch> <path> [--thread TS] [--comment T]` | share a file, prints its `F…` id |
| `post <ch> <text \| -> [--thread TS]` | post markdown, prints the `ts`; `-` reads stdin |
| `edit <ch> <ts> <text \| ->` | replace a message outright |
| `delete <ch> <ts>` | no undo |
| `react <ch> <ts> <emoji>` | `:eyes:`, the cheapest acknowledgement |

- `<ch>` is an id, `#name`, or a pasted message link, which also supplies
  `<ts>` and the thread: `thread <link>`, `post <link> "text"`.
- Times: ISO 8601 (naive = local), epoch seconds, or a `ts`. `--after` is
  strictly newer: re-read without seeing what you already saw.
- A wide range belongs on disk: `history … --threads --out raw.txt`, then
  read pieces. `--json` is raw API objects for a script, not for you.
- 11 000 chars per message; split across replies in one thread.
- Errors: one `slack: <method>: <code>` line. `not_in_channel` → someone
  `/invite`s the bot; `channel_not_found` → see `channels`; `missing_scope`
  → operator reinstalls the app; `cant_update_message` → not yours.

## Transcript format

```
# C079TC7GUBG 2024-06-01 00:00 → now · +0800 · 41 messages · last 1717.000400
09:12 ada: the db is on fire [thread 3 · 1717.000100] [file log.txt F1 2KB]
  09:14 bob: restarting it [edited] [:eyes: 2]
```

A date line when the day changes; replies indented under `--threads`.
Markers: `[edited]`, `[thread N · <ts>]` on a parent, `[in thread <ts>]` on
a reply met in the channel, `[file <name> <F…> <size>]`, `[:emoji: N]`;
`[attachment: t]`/`[blocks]` for empty text. `--ts` prefixes each line
with its `ts` (what `thread`, `edit`, `--after` take); `--ids` renders
`name[id]`; the header's `last <ts>` is your next `--after`.

## Markdown is not Slack syntax

`text` is standard markdown (never mrkdwn `*bold*`). Beyond it:

| Intent | Write | Not |
| --- | --- | --- |
| Mention a person | `<@U04B7Q2>` | `@alice` — pings nobody |
| Link a channel | `<#C0123456>` | `#general` |
| Notify the channel | `<!here>`, `<!channel>` | `@here` |
| `& < >` as text | `&amp; &lt; &gt;` | |

**Never guess an id**: a wrong `<@U…>` pings a stranger. Ids come from the
speaker header, `--ids` or `user`; never ask a human for theirs. A plain
`@name` you post is reported on stderr.

## Rules

- **Reply in the thread you were reached in** (`--thread <thread_ts>`); a
  top-level post is a stated choice.
- **Edit and delete only what you posted** (`whoami`); `edit` replaces the
  whole text, `delete` has no undo. Your chat reply is itself a new message in
  this thread: after cleaning one up, confirm with `react` or `<silent>`, not text.
- **In a busy thread say nothing unless needed**: `<silent>why</silent>`.
- Never post credentials or file contents you were not asked to share: a
  channel is wider than this conversation.
