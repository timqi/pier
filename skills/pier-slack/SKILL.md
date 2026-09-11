---
name: pier-slack
description: Slack from the shell with `pier slack` — read, post, edit, files — and Slack's mention syntax. Read before reading or posting to Slack.
---

# Slack from the shell

`pier slack --help` lists the subcommands (`whoami`, `channels`, `user`,
`history`, `thread`, `message`, `permalink`, `file`, `upload`, `post`,
`edit`, `delete`, `react`) and their flags. There is no Slack tool. The token
is the vault's (`SLACK_TOKEN`); an `approve`-level one may pause the command
until the operator approves. A `vault:` line is the pier-vault skill's.

Where you are: the first speaker header ends `slack:<channel>/<thread_ts>`;
without it, name a channel explicitly.

- `<channel>` is an id, `#name`, or a pasted message link, which also
  supplies `<ts>` and the thread: `thread <link>`, `post <link> "text"`.
- Times: ISO 8601 (naive = local), epoch seconds, or a `ts`. `--after` is
  strictly newer; the transcript header's `last <ts>` is your next `--after`.
- A wide range belongs on disk: `history … --threads --out raw.txt`, then
  read pieces. `--json` is for scripts, not for you.
- 11 000 chars per message; split across replies in one thread.
- Errors are one `slack: <method>: <code>` line: `not_in_channel` → someone
  `/invite`s the bot; `channel_not_found` → see `channels`; `missing_scope`
  → the operator reinstalls the app; `cant_update_message` → not yours.

## Transcript format

```
# C079TC7GUBG 2024-06-01 00:00 → now · +0800 · 41 messages · last 1717.000400
09:12 ada: the db is on fire [thread 3 · 1717.000100] [file log.txt F1 2KB]
  09:14 bob: restarting it [edited] [:eyes: 2]
```

A date line when the day changes; replies indented under `--threads`.
Markers: `[edited]`, `[thread N · <ts>]` on a parent, `[in thread <ts>]` on
a reply met in the channel, `[file <name> <F…> <size>]`, `[:emoji: N]`,
`[attachment: t]`/`[blocks]` for empty text. `--ts` prefixes each line with
its `ts` (what `thread`, `edit`, `--after` take); `--ids` renders `name[id]`.

## Markdown is not Slack syntax

`text` is standard markdown (never mrkdwn `*bold*`). Beyond it:

| Intent | Write | Not |
| --- | --- | --- |
| Mention a person | `<@U04B7Q2>` | `@alice` — pings nobody |
| Link a channel | `<#C0123456>` | `#general` |
| Notify the channel | `<!here>`, `<!channel>` | `@here` |
| `& < >` as text | `&amp; &lt; &gt;` | |

**Never guess an id**: a wrong `<@U…>` pings a stranger. Ids come from the
speaker header, `--ids` or `user`; never ask a human for theirs.

## Rules

- **Reply in the thread you were reached in** (`--thread <thread_ts>`); a
  top-level post is a stated choice.
- **Edit and delete only what you posted** (`whoami`); `edit` replaces the
  whole text, `delete` has no undo.
- **Your reply is itself a new message** in this thread — even a `<silent>`
  turn posts one muted footer line — so you cannot leave the thread with none
  of your messages; say so once.
- **In a busy thread say nothing unless needed**: `<silent>why</silent>`.
- Never post credentials or file contents you were not asked to share: a
  channel is wider than this conversation.
