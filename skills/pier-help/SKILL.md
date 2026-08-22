---
name: pier-help
description: How Pier itself works — durable sessions and what survives a restart, how messages reach you from Slack and Telegram, in-chat commands (/stop, /settings, /bind), interrupting a running turn, and what only the operator's Console can change. Read before explaining Pier's behavior or advising a user on how to use it.
---

# How Pier works

Pier is the workspace this session runs in: agent sessions behind chat
surfaces — a web workbench and IM channels (Slack and Telegram today) — plus
scheduled tasks, subagents and boards. Answer questions about it from the
facts below. If the answer is not here, say you do not know how this instance
is configured rather than guessing: the Console (Pier's admin web UI) is the
operator's source of truth.

## Sessions and persistence

- One durable session per conversation: a web chat, a Slack thread, a
  Telegram chat or topic. The mapping survives restarts — the next message
  lands in the same transcript with its context intact.
- Idle sessions leave memory but keep their transcript; they resume
  transparently on the next message. Never promise that a restart or a pause
  wipes context.
- A fresh start is explicit: "New session" in the chat settings panel or the
  web UI. The old transcript remains readable from the web workbench.
- The web workbench can also rewind to an earlier user turn and re-prompt;
  IM surfaces cannot.

## Messages while you are working

- A message sent mid-turn queues as a follow-up and lands after the turn.
- A leading `!` interrupts instead: `!wrong file, stop` is injected into the
  running turn as a steer.
- `/stop` aborts the current turn outright.

## In-chat commands and the settings panel

- `/settings` — or an addressed message with no text at all (a bare mention,
  an empty DM) — opens a panel: model, reasoning level, new session
  (optionally in a chosen directory), stop. Slack also accepts the bare words
  `stop`, `settings`, `bind <code>`.
- Panel taps never reach you. The next-step buttons under your own replies
  do — a click arrives as an ordinary user message with that label.

## Who may talk (groups and binding)

- Group messages pass a per-chat gate the operator sets: it can require a
  mention, require the sender to be bound, or both. Dropped messages are
  logged, never answered.
- Binding: the operator issues a code in the Console; the user DMs the bot
  `/bind <code>` (Slack: `bind <code>`). Codes expire after ~10 minutes.
- An unbound DM sender is told how to bind at most once per 10 minutes;
  their other messages are dropped. "The bot ignores my DMs" usually means
  not bound.

## Only the Console can change

Channel tokens and connections, per-chat gate policies, bind codes, provider
logins and credentials, the public address, security unlock. You have no tool
for any of these: point the user at the Console instead of improvising.

## The rest of the surface

- Chat conventions — next-step buttons, `file://` attachments, staying
  silent, `[name<id> time]` sender headers — are in `<pier>/AGENTS.md`,
  already in your context.
- Delegating and scheduling work: the pier-tasks skill. Reading and posting
  Slack: pier-slack. Presenting a report as a page: pier-boards.
