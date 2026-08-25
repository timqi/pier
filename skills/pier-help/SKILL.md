---
name: pier-help
description: How Pier itself works — durable sessions and what survives a restart, how messages and files reach you from Slack and Telegram, in-chat commands (/stop, /settings, /bind), interrupting a running turn, and what only the operator's Console can change. Read before explaining Pier's behavior or advising a user on how to use it.
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
- A long session does not hit a wall: when the context fills, Pi compacts it
  automatically — older turns become a summary. The transcript on disk keeps
  everything, but detail can leave *your* context, so a very old turn is worth
  re-reading rather than recalling. The web session header shows context used
  and how much is left.

## Files and images the user sends

- A photo or file sent on any surface (web paste, Telegram photo/document,
  Slack upload) is saved to `$PIER_HOME/inbox/` and reaches you as a trailing
  `[name](file:///…)` line on the message — a path, not the content.
- Read it with the read tool only when it matters to the task: every read
  puts the content in your context for good. An image you never read costs
  nothing.
- The file stays on disk after the conversation moves on; link it back
  (`[name](file:///…)`) whenever the user asks for it again.

## Messages while you are working

- On the web, a message sent mid-turn queues as a follow-up and lands after
  the turn; a leading `!` interrupts instead — `!wrong file, stop` is injected
  into the running turn as a steer.
- From an IM chat, every mid-turn message steers the running turn directly —
  no `!` needed, and a leading `!` is just content.
- `/stop` aborts the current turn outright.

## In-chat commands and the settings panel

- `/settings` — or an addressed message with no text at all (a bare mention,
  an empty DM) — opens a panel: model, reasoning level, new session
  (optionally in a chosen directory), stop. Slack also accepts the bare words
  `stop`, `settings`, `bind <code>`.
- Panel taps never reach you. The next-step buttons under your own replies
  do — a click arrives as an ordinary user message with that label.

## What a turn looks like from outside

- Telegram and Slack put a 👀 on the message that started a turn and take it
  off when the turn settles; a restart and a periodic sweep clear stragglers.
  A 👀 that never clears means the turn died, not that you are still thinking.
- Every finished reply carries its cost: elapsed time and the context size at
  completion (`1m14s · 32K tok`) — a running total, not this turn's spend. IM
  shows it as a footer line, the web on hover.
- A reply past the platform's message cap is split across several messages
  (Telegram ~3.8k chars); the footer and the next-step buttons ride the last
  one.

## Notifications on the web

- The workbench can push a notification when a turn finishes and no client
  had that session on screen — Settings → Instance → Notifications, per
  browser. Chrome and Edge on desktop work in a tab; **iPhone and iPad only
  notify the installed app**, so it is Share → Add to Home Screen first, then
  enable it from the icon's window. A "Send a test notification" button in the
  same card answers whether it actually arrives.
- Pier is installable (an **Install Pier** button appears in that same card on
  Chrome and Edge; elsewhere it is the address-bar icon), and an installed
  Pier badges its icon with the number of sessions carrying an unread turn.

## Who may talk (groups and binding)

- Group messages pass a per-chat gate the operator sets: it can require a
  mention, require the sender to be bound, or both. Dropped messages are
  logged, never answered.
- Binding: the operator issues a code in the Console; the user DMs the bot
  `/bind <code>` (Slack: `bind <code>`). Codes expire after ~10 minutes.
- An unbound DM sender is told how to bind at most once per 10 minutes;
  their other messages are dropped. "The bot ignores my DMs" usually means
  not bound.

## Service restart, reload and update

- `pier restart` is the graceful systemd path: it refuses new work, waits up to
  five minutes for active turns and Task runs, then restarts. If the deadline
  aborts an IM turn, the next process tells that conversation.
- `pier reload` stays in-process: channel adapters re-read configuration and
  idle, unwatched sessions reopen with current agent files on their next
  message. Streaming or watched sessions are not interrupted.
- `pier update` is deliberately different: the separate updater hard-stops the
  service, backs up the database, replaces the package, and starts it again.
  It can interrupt active work. All three are operator shell commands for an
  installed Linux systemd service, not tools available to the agent.

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
