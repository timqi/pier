# Continuous session (experimental design)

The contract for the trial of one continuous conversation per instance, in
front of a dispatcher session that routes work to task-run children.
Behaviour not named here is today's, owned by [03](03-web-workbench.md),
[04](04-im-channels.md) and [09](09-tasks-cli.md). "Gap" marks what does not
exist yet.

## Model

- The user talks to Pier as **one conversation per instance**, the same one on
  web, Slack DM and Lark DM.
- Behind it the **main session** (dispatcher) is a top-level Pi session: it
  answers, remembers, and launches work; it does not edit code itself.
- Real work is a child: `pier task run --prompt … --cwd <dir> --model <name>
  --thinking <level> [--timeout <s>]`, one `wt` worktree per feature
  (`wt switch -c <branch> --no-cd -y --format json` in the repo, its `.path` as
  `--cwd`).
- A follow-up on an existing feature continues that child (`--run <id>`, or
  `--session <id>` once idle), never a new one; the user's words go through
  verbatim, the dispatcher's additions after them, never a re-summary.
- Children are ordinary supervised runs: they do not delegate (09 §Two levels),
  count against the 6-run instance limit, and never rotate.
- Callbacks stay the only delivery (`skills/pier-tasks`); the ledger below is
  for orientation, never for waiting.

## Home and memory

- The main session's cwd is `$PIER_HOME/home` (`pierPath("home")`,
  `paths.ts`), created at first use.
- The dispatcher contract is injected from code, beside `<pier>/AGENTS.md`
  (`agent/pi.ts` `agentsFilesOverride`), as `<pier>/dispatcher.md`, only for a
  session whose cwd is the home; it is never written to disk. Gap: the
  factory's `instructions` getter is instance-wide, so `resourceLoader(cwd)`
  gains the cwd test.
- The home holds memory only:
  - `MEMORY.md` — durable facts, decisions, the project index (repo → path,
    worktree convention); injected once at session open, in the seed.
  - `memory/YYYY-MM-DD.md` — daily notes, instance-local date.
  - `AGENTS.md` — optional user additions, loaded by Pi as the cwd's own file.
- The dispatcher writes a note when a callback settles or a decision is made;
  no Pi hook, no pre-compaction flush.
- Repo knowledge is written by children into that repo's own `AGENTS.md`,
  never into the home.
- Recall is files plus transcripts: `rg` over `memory/` and the Pi session
  directory. Gap: the `agent/listing.ts` index is reachable only as `GET
  /api/search`; a `pier search <q>` over the CLI socket is optional work.
- No vector store or memory service is a dependency.

## Main session lifecycle

| Event | Rule |
| --- | --- |
| User message to the main session, head ≥ 1h since its last user message | rotate before delivering: create the next session, append a chain row, deliver to it |
| Callback to the main session | delivered to the head, whatever its idle time; never rotates |
| Rotation | the new session opens with the previous head's model and thinking level, then gets one seed system input |
| Seed (every chain session, the first included) | `MEMORY.md`, the run ledger (in flight, and finished since the previous rotation), today's and yesterday's daily notes, the previous head's last 3 exchanges verbatim |
| Surface | one line where the user message came from: `new session — idle 1h` |
| Within a stretch | Pi auto-compaction on, triggered near 100K context, the last ~20K kept |
| Head missing from Pi | a new head with reason `lost`, said on the surface, as `onStale` does for IM rows |

- 1h matches the `"long"` cache retention Pier requests for interactive
  sessions (`CacheRetentionBox`, `agent/pi.ts`); past it the cache is cold
  anyway.
- Rotation is lazy, on the next user message; no timer.
- Launch: the instance default model (`GET /api/config/defaults`) at `low`
  thinking; the operator's header pick sticks to the head and is inherited on
  rotation.
- Compaction mapping: Pi compacts when `contextTokens > contextWindow −
  reserveTokens` and keeps `keepRecentTokens` (default 20000,
  `DEFAULT_COMPACTION_SETTINGS`), so the target is `reserveTokens =
  contextWindow − 100000`, per model. Gap: settings.json is instance-wide;
  the main session applies it in memory with
  `live.settingsManager.applyOverrides({compaction})` after open, and
  recomputes on `setModel`.
- Gap: the seed is a new `SystemInputOrigin` kind (`session-seed`) in
  `core/types.ts`, so it renders as a system input card, not a user bubble.

## Run ledger

Today `pier task list` shows definitions only and the skill forbids status
checks; the dispatcher needs the runs it launched.

- Source: `task_runs` via `TaskStore.listRunsForSession` (`invokedBySessionId`),
  unioned over every session in the chain.
- Surface (required new work): `pier task runs` → JSON, in-flight runs plus
  runs finished in the last 24h, each `{runId, name, state, targetSessionId,
  cwd, queuedAt, finishedAt}`; refused outside a main session.
- The same read feeds the rotation seed and IM `/status`.
- Gap: callbacks and ownership follow the chain. A run launched by an earlier
  head calls back to the current head (`tasks/callbacks.ts`), and every chain
  member counts as its launcher for `--run`, `cancel` and `recover`
  (`tasks/operations.ts`).

## Storage (chain)

- No copy of any message: the continuous conversation is an ordered chain of
  Pi sessions, and their transcripts are the record.
- The only new state is one table (a `db.ts` migration):

```sql
CREATE TABLE main_chain (
  session_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  reason TEXT NOT NULL  -- 'first' | 'idle' | 'lost'
);
```

- The head is the row with the greatest `started_at`.
- Every surface addresses the conversation by one alias key resolved to the
  head in the router's resolver (`main.ts`), never by a session id. Gap: the
  router's in-memory key → session map is re-pointed on rotation.

## Web

- The instance switch lives in Settings → Instance (`settings.ts`
  `continuous`, default off); off is today's workbench, unchanged.
- On: a fixed first rail row opens the continuous conversation; the rail below
  it lists only the palette's Running set as **In progress**, and the group
  collapses when empty. Every other session is reached through ⌘K. The phone
  drawer shows the same two parts.
- Opening it scrolls to the newest message; scrolling up pages back one chain
  session at a time, with a divider naming the rotation (`new session — idle
  1h · <time>`).
- No paging within a session in the trial. Risk: a busy day without a 1h gap
  is one large session and one large `/history`.
- Only the head's turns are editable or rewindable; older sessions render
  read-only, and the composer always sends to the head.
- Children show as today's Background Run rows (`task-status`), never their
  content; a row opens the child session, which takes messages directly.
- Required routes (gaps):
  - `GET /api/continuous` → `{chain: [{sessionId, startedAt, reason}]}`,
    newest first; the client pages with `/history` per member.
  - `POST /api/continuous/messages` — the alias send, so a rotation between
    snapshot and send cannot land a message on an old head.
  - `/history` for a non-head member without opening it live (today
    `router.ensure` resumes it), and `turns/:index/edit` refused 409 there.
  - `history()` reads `pi.messages`, the post-compaction context, so compacted
    turns vanish from the view; the continuous view reads the branch
    (`sessionManager.getBranch()`) instead.

## IM

The switch is platform-level in the Console's Channels tab ("DMs use the
continuous session"), default off, effective only while the instance switch
is on. Off is today's behaviour: every top-level DM message opens its own
thread and session. Group chats never change.

| Inbound (switch on) | Goes to | Reply posts |
| --- | --- | --- |
| DM, top-level message | main session | the DM's main flow, no thread |
| DM, reply in a bound card thread | that child session, bypassing the dispatcher | the thread |
| DM, reply in another bound thread (web handoff, or a thread from before the switch) | its session; the binding is kept | the thread |
| DM, reply in an unbound thread | main session | the DM's main flow |
| DM, `/status` (Slack: `status`) | not a prompt; Pier answers from the ledger | the main flow |
| Group chat | unchanged | unchanged |

- The main-flow reply is the single exception to "Pier never posts into the
  main flow but the handoff root" ([04 Slack facts](04-im-channels.md#slack-facts)).
  Gap: Slack's send refuses an empty `thread_ts` and Lark always replies in
  thread; both adapters gain a chat-level conversation id for the DM.
- Gap: the router delivers a session's replies to one attached chat; the main
  session answers only the surface each user message came from, and a callback
  turn only the surface the run was launched from; no other IM surface mirrors
  it.
- `/status` lists in-flight runs one line each: `<name> · <state> · <age> ·
  <thread link>`; nothing in flight says so.

### Card lifecycle

| Step | Who | What |
| --- | --- | --- |
| Run launched from an IM turn | dispatcher | its reply says what was dispatched |
| Run reports its session (`task-status` with `targetSessionId`) | Pier | posts the card as a thread root (`openThread`) and binds the thread to the child through the handoff binding (`conversations.set` → attach) |
| Child turns | child | post in the card's thread |
| State change (`running` → `succeeded` / `failed` / `cancelled` / `interrupted`) | Pier, from the event stream | edits the card in place |
| Callback settles | dispatcher | one line in the main flow with the thread link; a decision it needs is next-step buttons |

- The card is `<task name> · <state>`, the cwd, and the web link
  (`<publicUrl>/#/session/<id>`); the model never writes it.
- The card needs no store: its message is the thread root, found through
  `conversations.keyOf(targetSessionId)`.
- A queued run has no card yet; it is visible in the dispatcher's reply and in
  `/status`.
- The callback's system note is not posted in the main flow; the card's final
  state and the dispatcher's line are its trace. A failure the dispatcher never
  gets to speak about still reaches the main flow as an error note (§5).
- Gap: `handoff.ts` gains the card root and its edit (Slack `chat.update`,
  Lark `message.patch`), and a consumer of the chain's `task-status` events
  drives it.

## Required new work

- `agent/pi.ts`: dispatcher contract injected for the home cwd; per-session
  compaction override.
- `core/types.ts`: `session-seed` system-input kind.
- `db.ts` + a chain store: `main_chain`, head lookup, rotation.
- `main.ts` / `core/router.ts`: alias key → head, re-pointed on rotation;
  reply to the originating surface.
- `tasks/callbacks.ts`, `tasks/operations.ts`: callback and ownership follow
  the chain.
- `tasks/cli.ts`, `tasks/operations.ts`: `pier task runs`.
- `web/server.ts`: `/api/continuous`, alias send, read-only non-head history,
  branch-based history, edit refused off-head.
- `web/ui/`: rail entry, In progress group, chain paging and divider.
- `settings.ts`, `channels/config.ts`: the two switches.
- `channels/slack.ts`, `channels/lark.ts`: main-flow DM reply, card root and
  edit, `/status`.
- `channels/handoff.ts`: card binding on `task-status`.
- `skills/pier-tasks/SKILL.md`: the ledger line for the dispatcher.

## Acceptance

- A week of daily use from web and one IM DM with no manually opened session.
- Every rotation, dispatch, card state change, callback and failure is visible
  on the surface it came from.
- A follow-up on a feature reaches the same child (same session id in the
  ledger) and the user's words appear verbatim in the child's transcript.
- After a restart mid-run: the card still updates, the callback reaches the
  head, `/status` is right.
- The main session writes no code: its transcript shows no edits outside
  `$PIER_HOME/home`.
- The largest head of the week is recorded; above ~300K transcript tokens,
  intra-session paging is next work.
