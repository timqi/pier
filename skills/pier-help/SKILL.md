---
name: pier-help
description: How Pier itself works — durable sessions, what survives a restart, how messages and files reach you from IM, in-chat commands, and what only the operator's Console can change. Read before explaining Pier's behavior or advising a user on it.
---

# How Pier works

Pier is the workspace this session runs in: agent sessions behind chat
surfaces — a web workbench and IM channels (Slack, Lark) — plus
scheduled tasks, subagents and boards. Answer from the facts below. If the
answer is not here, say you do not know how this instance is configured rather
than guessing: the Console (Pier's admin web UI) is the operator's source of
truth.

## Sessions and persistence

- One durable session per conversation: a web chat, a Slack or Lark thread.
  The mapping survives restarts — the next message
  lands in the same transcript with its context intact.
- Idle sessions leave memory but keep their transcript; they resume
  transparently on the next message. Never promise that a restart or a pause
  wipes context.
- A fresh start is explicit: "New session" in the chat settings panel or the
  web UI. The old transcript remains readable from the web workbench.
- The web workbench can also rewind to an earlier user turn and re-prompt;
  IM surfaces cannot.
- A web session can be continued in Slack or Lark: the web session menu's
  "Continue in Lark/Slack…" posts one message in a chat the bot knows, and
  replies in that thread reach the same session. The other way round, the
  settings panel of a thread with no session yet offers "Continue web
  session…", a picker of sessions no chat answers for. Every reply then lands
  on both surfaces; a session already answering a chat cannot be moved.
- A long session does not hit a wall: when the context fills, Pi compacts it
  automatically — older turns become a summary. The transcript on disk keeps
  everything, but detail can leave *your* context, so a very old turn is worth
  re-reading rather than recalling. The web session header shows context used
  and how much is left.

## Files and images the user sends

- A photo or file sent on any surface (web paste, Slack or Lark upload) is saved to `$PIER_HOME/inbox/` and reaches you as a trailing
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
- `/stop` from an IM chat aborts the current turn outright; the web has a Stop
  button.

## In-chat commands and the settings panel

- `/settings` — or an addressed message with no text at all (a bare mention,
  an empty DM) — opens a panel: model, reasoning level, new session, stop.
  "New session in…" offers the recent session directories as buttons and a
  typed path; the session is created on the tap, and the thread's first
  message runs in it. Slack also accepts the bare words `stop`, `settings`,
  `bind <code>`.
- Panel taps never reach you. The next-step buttons under your own replies
  do — a click arrives as an ordinary user message with that label.
- The panel reads the thread's real session, resuming an idle one; in a thread
  with no session yet, Model and Reasoning are refused until one is started.
  A session created from the panel keeps its directory, model and reasoning
  across a restart even before its first message.

## What a turn looks like from outside

- IM channels put a 👀 (Lark: "OnIt") on the message that started a turn and
  take it off when the turn settles; a restart and a periodic sweep clear stragglers.
  A 👀 that never clears means the turn died, not that you are still thinking.
- Every finished reply carries its cost: elapsed time and the context size at
  completion (`1m14s · 32K tok`) — a running total, not this turn's spend. IM
  shows it as a footer line; the web shows the duration in the reply's activity
  headline and the context size in the session header.
- A reply past the platform's message cap is split across several messages
  (Slack ~2.8k chars, Lark ~7k); the footer and the next-step buttons ride the last
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

- `pier restart`: refuses new work, waits up to five minutes for active turns
  and Task runs, then restarts. If the deadline aborts an IM turn, the next
  process tells that conversation.
- `pier reload`: channel adapters re-read configuration and idle, unwatched
  sessions reopen with current agent files on their next message. Streaming or
  watched sessions are not interrupted.
- `pier update`: a separate updater backs up the database and installs the new
  package while Pier is still up, then hard-stops and starts the service. From
  the shell it does not drain, so it can interrupt active work; the Console's
  Update and auto-update drain first. All three are the operator's, for an
  installed Linux systemd service: `pier` on your PATH runs them too, so never
  type one yourself — point the user at them.

## Only the Console can change

Channel tokens and connections, per-chat gate policies, bind codes, provider
logins and credentials, vault secrets (Settings → Vault files a name; you only
ever use one through `pier vault run`), the public address, security unlock.
You have no tool for any of these: point the user at the Console instead of
improvising.

## The rest of the surface

- Chat conventions — next-step buttons, `file://` attachments, staying
  silent, `[name<id> time place]` sender headers — are in `<pier>/AGENTS.md`,
  already in your context.
- Delegating and scheduling work: the pier-tasks skill. Reading and posting
  Slack: pier-slack. A command that needs a token or key: pier-vault.
  Presenting a report as a page: pier-boards.
