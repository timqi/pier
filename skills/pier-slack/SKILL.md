---
name: pier-slack
description: Read and write Slack through Pier's slack tool — a channel's history for a time range, one thread, posting into a thread, and the Slack-specific syntax for mentions and links. Read before answering questions about Slack conversations or posting anything to a workspace.
---

# Reading and writing Slack

Pier holds the bot token and makes every call itself. You state an intent; it
resolves the channel, serves what it has cached, fetches only the gap, and posts
on your behalf. You never see a token or a scope.

## Where am I

If this conversation reached you *through* Slack you are already standing in a
channel and a thread, and **omitting `channel` means "here"**:

- `{"operation":"post","text":"..."}` replies in the thread you are in
- `{"operation":"read_thread"}` reads it
- `{"operation":"context"}` names it, when you need the ids

```json
{"inSlack":true,"channel":"C0123456","channelName":"#ops",
 "kind":"group","threadTs":"1717243800.123456"}
```

`inSlack:false` means a task, subagent or web session started this — there is no
current conversation and `channel` is required.

You only need ids to reach somewhere you are *not*. `{"operation":"channels"}`
lists what Pier has seen (`id`, `name`, `kind`, `respondsToMessages`); pass
either an id or a `#name` anywhere a channel is wanted. The bot reaches only
channels it was invited to — `not_in_channel` means someone must run
`/invite @Pier`.

## Never ask for an id

You already have them:

- **The person talking to you.** A message may start with `[name<id> time]` —
  that is the sender, added by Pier, not something they typed. It appears only
  when the speaker or the day changes, so the last one you saw still applies.
- **Anyone in a transcript.** `read_channel` and `read_thread` return `userId`
  beside `user` on every message.
- **This channel and thread.** From `context`, above.

Asking a human to paste their own user ID is never acceptable.

## Reading

```json
{"operation":"read_channel","channel":"#incidents",
 "since":"2024-06-01T00:00:00Z","until":"2024-06-02T00:00:00Z"}
```

- `since` / `until` take **ISO 8601 or epoch seconds**. Omitting `until` reads
  up to now and always fetches, since "now" cannot be cached.
- `limit` caps the result (default and max 400). If `truncated` is true, narrow
  the range rather than raising the limit.
- Messages arrive oldest-first with `ts`, `at` (ISO), `threadTs`, `user`,
  `userId` and `text`.
- A channel read returns thread **parents**, not the replies inside each thread.
  Follow a message's `threadTs` when the replies matter.

```json
{"operation":"read_thread"}
```

Omit both arguments for the thread you are in; pass `channel` + `thread_ts` for
another. Returns the parent plus every reply, oldest first. A cached thread is
re-read after a minute, because threads grow.

## Posting

```json
{"operation":"post","text":"**Deploy done** — 3 services, 0 rollbacks."}
```

| Goal | Arguments |
| --- | --- |
| Reply where you are | omit `channel` and `thread_ts` |
| Reply in a specific thread | `channel` + `thread_ts` |
| Start a new top-level message | `thread_ts: "none"` |

`"none"` is deliberately explicit: a channel's main flow is visible to everyone
in it. A `thread_ts` is never inherited across a change of `channel`. The
response carries `ts` and `threadTs` so you can reply under what you just
posted.

## Message syntax

`text` is **standard markdown** and Slack renders it natively: `**bold**`,
`_italic_`, `` `code` ``, fenced blocks, `# headings`, `- lists`, tables and
blockquotes. Do not hand-convert to the older `*bold*` mrkdwn — it renders
literally.

Four things are Slack syntax, which markdown cannot express:

| Intent | Write | Not |
| --- | --- | --- |
| Mention a person | `<@U04B7Q2>` | `@alice` — plain text, no ping |
| Link a channel | `<#C0123456>` | `#general` — plain text |
| Notify a group | `<!here>`, `<!channel>` | `@here` — plain text |
| Hyperlink | `[label](https://…)` | — |

- **Never guess an id from a name.** A wrong `<@U…>` either fails or pings a
  stranger, and both look like it worked. With no id, write the person's name
  as prose instead of a fake mention.
- **Escape `&`, `<`, `>`** when they are text and not markup: `&amp;`, `&lt;`,
  `&gt;`.
- Emoji as `:white_check_mark:`, not the raw glyph.
- ~11,000 characters per message. Split longer content across replies in one
  thread rather than truncating.

## Rules

- **In a busy thread, say nothing unless you are needed.** You are handed every
  message, including humans talking to each other. `<silent>why</silent>` sends
  no message at all — prefer it to acknowledging what was not addressed to you.
- Read before you write. A summary of the wrong thread is worse than none.
- Never post credentials, tokens or file contents you were not asked to share:
  a channel is usually wider than the conversation you are in.
- "Slack agent access is switched off" means the operator disabled it on
  purpose. Say so and stop; do not look for another route.
- Resolve vague times ("yesterday") to an explicit ISO range and say which
  range you used.
