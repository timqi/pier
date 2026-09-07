---
name: pier-slack
description: Read and write Slack through Pier's slack tool, including the Slack-specific syntax for mentions and links. Read before answering questions about Slack conversations or posting anything to a workspace.
---

# Writing Slack correctly

The tool description lists the operations and parameters. This is what goes
wrong without instructions.

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
- **You already have the ids** — the sender header on the message you are
  answering, `name[id]` on every transcript line, `context` for this channel and
  thread. Asking a human to paste their own user ID is never acceptable.
- Escape `&` `<` `>` when they are text, not markup: `&amp;` `&lt;` `&gt;`.
- Emoji as `:white_check_mark:`, not the raw glyph.
- ~11,000 chars per message: split longer content across replies in one thread
  rather than truncating.

## Targeting

- Omitting `channel`/`thread_ts` means "here" — the conversation that reached
  you. `context` names it; `inSlack:false` means a task, subagent or web session
  started this, so `channel` is required.
- `channels` lists what Pier can reach; an id or a `#name` works anywhere a
  channel is wanted.
- `thread_ts:"none"` is the only way to a new top-level message — a channel's
  main flow is wider than a thread. A `thread_ts` is never inherited across a
  change of `channel`.
- A `ts` means nothing outside the conversation it was read in, and `edit` /
  `delete` always take it explicitly — no default from the thread you are in.

## Reading

- A channel read returns thread **parents** only; `[thread: N replies]` marks
  the ones worth a `read_thread`.
- `read_message` also needs `thread_ts` when the message was posted inside a
  thread — a channel read cannot see thread replies.
- The leading `ts` on a line is Slack's id: pass it back as `thread_ts` or
  `after`. `after` is strictly newer, for re-reading without seeing what you
  already saw.
- `truncated` → narrow the range rather than raising `limit` (default and max
  400). `incomplete` → the read stopped early for the reason given; work with a
  partial answer, but never report it as everything.
- Resolve a vague time ("yesterday") to an explicit ISO range and say which
  range you used.

## Files

`[file: <name> <F… id> <size>]` on a line is an upload, never its bytes.
`fetch_file` with that `F…` id (no `channel` needed) saves it and replies with a
marker line — `[postmortem.pdf](file:///…)` — so you read it only if the
question needs its contents. Over 32 MB or refused by Slack: `[attachment lost:
<name> — <reason>]`.

## Rules

- Read before you write. A summary of the wrong thread is worse than none.
- **In a busy thread, say nothing unless you are needed.** You are handed every
  message, including humans talking to each other. `<silent>why</silent>` sends
  nothing at all — prefer it to acknowledging what was not addressed to you.
- `edit` replaces `text` outright; read the message first if you are changing
  part of it. Slack keeps no version a reader can open and may not mark the
  message as edited, so when the previous wording mattered to people, say what
  changed instead of quietly rewriting history. A running status or tally is
  better as one message edited in place than one message per change.
- `delete` cannot be undone, and deleting a thread parent leaves its replies.
  Say what you removed; a message vanishing with no word looks like a bug.
- Never post credentials, tokens or file contents you were not asked to share:
  a channel is usually wider than the conversation you are in.
- "Slack agent access is switched off" means the operator disabled it on
  purpose. Say so and stop; do not look for another route.
