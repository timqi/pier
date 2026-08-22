---
name: pier-slack
description: Read and write Slack through Pier's slack tool — a channel's history for a time range, one thread, posting into a thread, and the Slack-specific syntax for mentions and links. Read before answering questions about Slack conversations or posting anything to a workspace.
---

# Reading and writing Slack

Pier holds the bot token and makes every call itself. State what you want; it
resolves the channel, pages the API and hands back a finished transcript. Reads
are live and nothing is kept between calls — write down what you need to keep.

## Where am I

If this conversation reached you *through* Slack, omitting `channel` means
"here":

- `{"operation":"post","text":"..."}` replies in the thread you are in
- `{"operation":"read_thread"}` reads it
- `{"operation":"context"}` names it: `channel`, `channelName`, `kind`,
  `threadTs`

`inSlack:false` from `context` means a task, subagent or web session started
this: there is no current conversation and `channel` is required.

`{"operation":"channels"}` lists what Pier can reach (`id`, `name`, `kind`,
`respondsToMessages`); pass either an id or a `#name` anywhere a channel is
wanted. `not_in_channel` means someone must run `/invite @Pier`.

## Never ask for an id

You already have them:

- **The person talking to you** — a message may start with `[name<id> time]`,
  added by Pier, not typed by them. It appears only on a change — new speaker,
  a time gap, a new day — so the last one you saw still applies (a gap alone
  shows as time only, like `[14:23]`).
- **Anyone in a transcript** — every line carries `name[id]`.
- **This channel and thread** — from `context`.

Asking a human to paste their own user ID is never acceptable.

## Reading

```json
{"operation":"read_channel","channel":"#incidents",
 "since":"2024-06-01T00:00:00Z","until":"2024-06-02T00:00:00Z"}
```

```json
{"operation":"read_thread"}
```

Omit both arguments for the thread you are in; pass `channel` + `thread_ts` for
another. A thread read returns the parent plus every reply, with `threadTs` at
the top of the reply rather than on each line.

```json
{"operation":"read_message","channel":"#ops","ts":"1717243800.000100"}
```

One message and nothing else, when that is the whole question. Add `thread_ts`
when it was posted inside a thread — a channel read cannot see thread replies,
and the error will say so.

- `since` / `until` / `after` take **ISO 8601, epoch seconds, or a `ts` from an
  earlier read**. Omitting `until` reads up to now.
- `after` returns only what is strictly newer than that message — use it to
  re-read a channel or thread without seeing what you saw last time.
- `limit` caps the result (default and max 400). When `truncated` is true,
  narrow the range rather than raising the limit.
- Messages are oldest-first, one line each, shaped as the reply's `format`
  field says — `<ts> | <time, UTC> | <name>[<id>] | <text>`:

  ```
  1717243800.000100 | 2024-06-01T12:10Z | Ada[U1] | deploy? [thread: 4 replies]
  ```

  The leading `ts` is Slack's id: pass it back as `thread_ts` or `after`.
- A channel read returns thread **parents** only; `[thread: N replies]` marks
  the ones worth opening with `read_thread`.
- `incomplete` means the read stopped early and its value says why. Retry or
  work with a partial answer, but do not report it as everything.

## Posting

```json
{"operation":"post","text":"**Deploy done** — 3 services, 0 rollbacks."}
```

| Goal | Arguments |
| --- | --- |
| Reply where you are | omit `channel` and `thread_ts` |
| Reply in a specific thread | `channel` + `thread_ts` |
| Start a new top-level message | `thread_ts: "none"` |

Going top-level takes the explicit `"none"`: a channel's main flow is wider
than a thread. A `thread_ts` is never inherited across a change of `channel`.
The response carries `ts` and `threadTs` for replying under what you posted.

## Message syntax

`text` is **standard markdown** and Slack renders it natively: `**bold**`,
`_italic_`, `` `code` ``, fenced blocks, `# headings`, `- lists`, tables and
blockquotes. Never hand-convert to the older `*bold*` mrkdwn; it renders
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
  as prose.
- **Escape `&`, `<`, `>`** when they are text and not markup: `&amp;`, `&lt;`,
  `&gt;`.
- Emoji as `:white_check_mark:`, not the raw glyph.
- ~11,000 characters per message. Split longer content across replies in one
  thread rather than truncating.

## Rules

- **In a busy thread, say nothing unless you are needed.** You are handed every
  message, including humans talking to each other. `<silent>why</silent>` sends
  nothing at all — prefer it to acknowledging what was not addressed to you.
- Read before you write. A summary of the wrong thread is worse than none.
- Never post credentials, tokens or file contents you were not asked to share:
  a channel is usually wider than the conversation you are in.
- "Slack agent access is switched off" means the operator disabled it on
  purpose. Say so and stop; do not look for another route.
- Resolve vague times ("yesterday") to an explicit ISO range and say which
  range you used.
