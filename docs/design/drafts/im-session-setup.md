# IM session setup: truthful control, create-before-prompt, web → IM handoff (draft)

Design for three PR-sized steps. Read-only survey of the code as of `ca252b7`;
where the code contradicts the brief the contradiction is named and the design
follows the code.

## 1. Goal and non-goals

- A panel action on an IM thread either acts on the thread's real session or
  says there is none; never a confirmed no-op (`control.ts` today).
- Directory, model and reasoning can be chosen in a thread *before* the first
  prompt runs, durably: a restart or an idle eviction between the choice and
  the first message loses nothing.
- Recent session directories are one tap away; the typed path stays as the
  fallback.
- A web-started session can be continued from Lark or Slack with one message
  Pier posts, and the binding survives restarts in both directions.
- Not doing: slash commands, autocomplete, an IM-side session browser,
  changing chat/bot defaults from chat, moving a session between IM threads.

## 2. Behaviour as the user sees it

### Two facts the design is built on

1. **Pi writes nothing until the first assistant message.** `SessionManager._persist`
   (pi-coding-agent `dist/core/session-manager.js:739`) buffers every entry
   until an assistant message exists; `web/server.ts:203` (`nascent`) works
   around the same fact. So a session the panel "creates" has no file: after an
   idle eviction (30 min, `Router.evictIdle`) or a restart, `factory.resume`
   throws `unknown session`, `resolveConversation` forgets the row and creates
   a fresh session with the *chat defaults* — the exact silent loss the brief
   forbids, and a bug "New session in…" already has today. The brief's
   "session created ⇒ durable" does not hold in Pi; the design keeps the
   decided UX (create on directory choice, apply model/reasoning live) and
   makes the *launch record* durable beside the session id (§3.2). This is not
   in-memory draft state: it is what re-creates the same session losslessly
   when Pi has no transcript to resume.
2. **`Router.reached` lets any chat key take a session over** (`router.ts:595`),
   so "one IM destination per session" is enforced where rows are written
   (`handoff.ts` refuses a second), not in the router.

### Lark (phone)

- `@bot` alone or `/settings` in a fresh topic opens the panel. Session group:

  > **Session**
  > None in this thread yet — your first message starts one with the chat
  > defaults below. To choose the directory first, tap *New session in…*.

  Chat group gains one line under the gates:

  > New sessions start in `/home/qiqi/code` · claude-sonnet-4-5 · reasoning medium

  ("Pier's directory" when cwd is unset, "Pi default" for a null model,
  "default reasoning" for null thinking.) Defaults are display only.
- *New session in…* shows up to 6 recent directories as buttons (labelled by
  their last two path segments, full paths listed above the row, numbered),
  then **Type a path…** (the existing form card) and **‹ Back**. A tap creates
  the session at once. Note under the panel:

  > Created session `a1b2c3d4` in `/home/qiqi/code/pier` — nothing has run
  > yet; the first message you send in this thread starts it.

  Session group for that state:

  > `a1b2c3d4` · created, no message yet
  > Directory: `/home/qiqi/code/pier`
  > Model: claude-sonnet-4-5 · reasoning medium
  > Context: empty — the first message you send runs here.

- *Model* / *Reasoning* on a created-but-unprompted session apply to it and
  confirm as today ("Model set to X."). On a thread with no session:

  > No session in this thread yet — start one first (New session / New session in…).

  On an evicted session the panel resumes it first; the confirmation is the same
  sentence and the Session group shows the real values.
- A reply in that topic after a Pier restart, without a mention, is answered:
  the row exists, so `knows()` is true.
- Web → Lark: the operator picks *Continue in Lark/Slack…* in the web header
  menu and chooses `Lark · DM · Qi`. The bot posts one root card in that chat:

  > **Continued from web: Fix the parser**
  > [Open on the web](https://pier.g1.timqi.com/#/session/…)
  > Reply in this thread to continue.

  then one in-thread card `Reply here to continue.` (why two: §4 Q1). The
  phone gets Lark's normal message notification (DM: direct; group: per the
  member's group setting, no `@`). Replies in that topic go to the web session;
  every later reply of the session lands both on the web and in the topic.

### Slack (desktop/phone)

Same panel and copy, Slack rendering: recent directories are one `actions`
row; **Type a path…** opens the existing modal (title "New session", submit
"Create", hint "The session is created here at once; the first message you
send in this thread runs in it."). Handoff root message (mrkdwn):

> Continued from web: *Fix the parser*
> https://pier.g1.timqi.com/#/session/…
> _Reply in this thread to continue._

Slack threads open from any message, so no second message.

### Web

- ⋯ menu (header and rail row) gains **Continue in Lark/Slack…** after
  *Browse files*. For a session already answering in a chat the row is
  disabled with hint `answers in slack`. The picker panel:

  > **Continue in a chat**
  > Chats the bot has seen. A chat appears here after its first message to
  > the bot.
  > `Lark · DM · Qi` / `Slack · group · #ops` …
  > (empty) No chats yet — message the bot once in Lark or Slack, then come back.

  A pick posts the handoff; on success the panel closes and the rail row's
  channel chip appears (`sessions-changed`). On failure the panel stays open
  with the server's sentence under the row (as `dir-picker.ts` does).
- After a handoff the session's web push is suppressed (it now "answers lark",
  `push.ts` `channelOf`) — the phone hears from Lark instead. Web prompts are
  not mirrored to the chat; replies are (existing behaviour for IM-born
  sessions continued on the web).

## 3. Design per step

Budgets, `just size` now: core 1378/1.5k · channels 3937/4.2k · web 12191/14k ·
root 3205/3.25k; `channels/slack.ts` 428 is already over the 400 adapter-file
ceiling.

### Step 1 — truthful control

**Problem in code.** `control.ts:87-93` `setModel`/`setThinking` use
`router.sessionOf(key)?.…` — undefined for a thread with no session *and* for
one evicted after 30 idle minutes; `panel.ts` then prints "Model set to X."
`status()` (`control.ts:68`) returns `null` for both. `pickThinking` has no
`catch`. `resolveConversation`'s stale path (`conversations.ts:67`) re-routes a
thread to a default session with only a log line.

**Files.** `channels/control.ts`, `channels/conversations.ts`,
`channels/panel.ts`, `main.ts`, `db.ts` (index only), tests.

**`channels/control.ts`**

```ts
export interface ConversationStatus {
  sessionId: string; cwd: string; state: SessionState;
  /** No turn in the transcript yet: the panel says "created, no message yet". */
  empty: boolean;
  model: ModelRef | undefined; thinking: ThinkingLevel; thinkingLevels: ThinkingLevel[];
  tokens: number | null; contextWindow: number | null;
}

export interface ChannelControl {
  …unchanged…
  /** What the chat's next session would launch with, for the panel's defaults line. */
  launchFor(key): Partial<AgentLaunchOptions>;   // already exists
  status(key): Promise<ConversationStatus | null>;   // null = no row; resumes an evicted session
  setModel(key, model): Promise<void>;     // rejects NO_SESSION when there is no row
  setThinking(key, level): Promise<void>;  // same
}
export const NO_SESSION = "No session in this thread yet — start one first (New session / New session in…).";
```

Private helper, the one place the rule lives:

```ts
/** The thread's session, resumed if evicted; undefined when the thread has none.
 *  Never creates: a look at the panel must not open a session. */
const live = async (key: ConversationKey): Promise<AgentSession | undefined> => {
  if (!conversations.get(key)) return undefined;
  return router.sessionOf(key) ?? router.ensure(key);
};
```

`router.ensure` on a known row resolves through `resolveConversation`; if the
transcript is gone that path re-creates (below) and the thread is told, so
`status()` may return a different `sessionId` than the row had — the panel
shows the new id, the chat got the note. `status()` computes
`empty: (await session.history()).length === 0`. `setModel`/`setThinking`:
`const s = await live(key); if (!s) throw new Error(NO_SESSION); …`.

**`channels/conversations.ts`** — `resolveConversation` gains the thread as
its stale callback's argument so the chat hears it (§5):

```ts
onStale?: (key: ConversationKey, message: string) => void
// message: `Session ${known.slice(0,8)} is gone from disk; this thread continues in a new session in ${cwd}.`
```

`main.ts:148` wires `(key, m) => { warn(m); void channels.notify(key.channelId, key.conversationId, m); }`.
(`ChannelRuntime.notify` exists; `channels` is in scope.)

**`channels/panel.ts`**

- Session group, no session (copy in §2). Chat group: one `defaults` line from
  `control.launchFor(key)`.
- `sessionLines`: first line `… · created, no message yet` when `status.empty`
  and `state === "idle"`; Context line `empty — the first message you send
  runs here.` when `empty`.
- `pickThinking` gets the same `try/catch` as `pickModel`; both print
  `String(err)` (which is `NO_SESSION` for the no-row case).

**Wire.** No HTTP. Panel actions unchanged.

**Failure paths (what the user sees).**

| Case | Panel note |
| --- | --- |
| Model/Reasoning, no row | `No session in this thread yet — start one first (…)` |
| Model/Reasoning, evicted | resumed silently; `Model set to X.` |
| Model/Reasoning, row but transcript gone | chat gets the stale note; panel note `Model set to X.` on the new session; Session group shows the new id |
| Resume fails for another reason (Pi error) | `Could not set that model: <error>` / `Could not set reasoning: <error>`; `Router.unopened` also posts the error to the thread |

**Restart.** Nothing new to restore: `conversations` is already the truth.

**Tests.**

- `channels/control.test.ts` (new; real `Router` + `EventHub`, fake
  `AgentFactory` as `router.test.ts`'s `fakeSession`): `status is null for a
  thread without a row`; `status resumes an evicted session instead of
  answering null`; `setModel on a thread without a row rejects with
  NO_SESSION and touches no session`; `setThinking resumes then applies`;
  `a row whose transcript is gone re-creates and tells the thread`.
- `channels/conversations.test.ts`: `stale re-route reports the thread and
  the message names both sessions`.
- `channels/panel.test.ts`: `no session: the group says how one starts and the
  chat line shows the defaults`; `reasoning pick with no session prints
  NO_SESSION, not a confirmation`; `an empty session reads "created, no message
  yet"`.

**Delta.** control +18, conversations +4, panel +14, main +2 → channels ≈ 3975.

### Step 2 — create from the panel, recent directories, durable launch

**Files.** `db.ts` (migration 25), `channels/conversations.ts`,
`channels/control.ts`, `channels/panel.ts`, `channels/slack-panel.ts`,
`channels/lark-panel.ts`, `docs/design/04-im-channels.md`,
`skills/pier-help/SKILL.md`, tests.

**DB row.** Migration 25 (append-only):

```sql
-- What the thread's session was created with, and the model/reasoning set on
-- it since. Consulted only when Pi has no transcript to resume: a session
-- never prompted was never written, and is re-created from this instead of
-- from the chat defaults.
ALTER TABLE conversations ADD COLUMN launch TEXT;
CREATE INDEX conversations_session ON conversations(session_id);   -- keyOf (Step 3) and channelOf
```

`launch` is `JSON.stringify(AgentLaunchOptions)` or NULL (rows written before
25, and rows `resolveConversation` writes for a first message — those launched
from the chat defaults, which is also what a stale re-create should use).

**`channels/conversations.ts`**

```ts
set(key, sessionId, launch?: AgentLaunchOptions): void;      // launch NULL when omitted
launchOf(key): AgentLaunchOptions | undefined;
/** Merge a model/reasoning change into the record, so a never-written session re-creates as last configured. */
amendLaunch(key, patch: Partial<Pick<AgentLaunchOptions, "model" | "thinking">>): void;
```

`resolveConversation` stale branch: `const launch = store.launchOf(key) ?? {...launchFor(key)}`;
create with it; `store.set(key, session.id, launch)`. The stale note names the
cwd it re-created in, and says `re-created with its own settings` vs
`continues in a new session with the chat defaults` — two sentences, one
branch each.

**`channels/control.ts`**

```ts
newSession(key, cwd?): Promise<string>   // writes conversations.set(key, id, {cwd, model, thinking}) — the launch it actually used
setModel(key, model)                     // after success: conversations.amendLaunch(key, {model})
setThinking(key, level)                  // after success: conversations.amendLaunch(key, {thinking: level})
/** Distinct cwds of the backend's session listing, newest first; the chat's own default first when set. */
recentDirs(key: ConversationKey, limit = 6): Promise<string[]>
```

`recentDirs` = `factory.list()` (already sorted by `modified` desc,
`agent/pi.ts:819`) → `s.cwd` → dedupe → prepend `launchFor(key).cwd` if set →
slice. Task-run sessions are in that list too (control cannot see
`tasks.taskSessions()`); their cwd is a project directory as well — accepted
(§4 Q3).

**`channels/panel.ts`**

- `PanelState` gains `dirs: string[]` (the list `cwd:<i>` indexes, like
  `models`).
- `cwd` action → `showDirs(key)`: group `New session in` with lines
  `1. /full/path` …, `picks` = `btn("1 …/dev/pier", "cwd:0")` …, rows
  `[btn("Type a path…", "cwdtype"), btn("‹ Back", "panel")]`. Empty listing
  (fresh instance) → line `No sessions yet — type a path.` and only the two
  buttons. Listing failure → `Could not list recent directories: <error>` plus
  the two buttons (same shape as `showModels`'s `unavailable`).
- `cwd:<i>` → `startSessionIn(key, state.dirs[i])`; stale index →
  `That directory is no longer listed.` (mirrors `pickModel`).
- `cwdtype` → `promptCwd` (unchanged platform halves; Slack modal submit label
  `Create`, `CWD_TAIL` reworded per §2).
- `startSessionIn` / `new` note: `` Created session `xxxxxxxx` in <path> — nothing has run yet; the first message you send in this thread starts it. ``
  (`new` says `in its directory`.)
- Button label: `…/${last two segments}`; a path shorter than that is shown
  whole. Lark truncates labels near 60 chars (`lark-render.ts BUTTON_MAX`),
  which two segments stay under in practice; the numbered lines carry the full
  path.

**Wire.** Panel actions: `cfg:cwd` (now a view), `cfg:cwd:<i>`, `cfg:cwdtype`.
Slack modal/Lark form payloads unchanged.

**Failure paths.**

| Case | User sees |
| --- | --- |
| Pi refuses the directory (does not exist, unreadable) | `Could not start a session there: <error>` (exists) |
| Relative path typed | `That is not an absolute path — nothing changed.` (exists) |
| Listing fails | dirs view says so, typed fallback still offered |
| Stale `cwd:<i>` after a redraw | `That directory is no longer listed.` |
| Panel from a previous process | first tap reopens (existing `reopen`) |
| Restart/eviction before the first message | next message re-creates from `launch` — same cwd, model, reasoning; thread note: `` Session xxxxxxxx had no message yet and was not saved; re-created as yyyyyyyy with its own settings in <cwd>. `` |

**Restart.** Row + `launch` are the state; the live object is a cache.

**Tests.**

- `db.test.ts`: migration 25 on a 24 database keeps rows, `launch` NULL.
- `channels/conversations.test.ts`: `set/launchOf round trip`;
  `amendLaunch merges model then thinking`; `stale re-route uses the launch
  record, not the chat defaults`; `stale re-route without a record uses the
  chat defaults and says so`.
- `channels/control.test.ts`: `newSession records the launch it used`;
  `setModel amends the record`; `recentDirs dedupes, newest first, chat cwd
  first`.
- `channels/panel.test.ts`: `New session in… lists recent directories as
  buttons with numbered full paths`; `cwd:<i> creates there and the note
  distinguishes created from run`; `Type a path… opens the modal`; `empty
  listing offers only the typed path`; Lark: `cwd form submit after a restart
  re-remembers the card` (exists — keep).

**Delta.** db +4, conversations +22, control +16, panel +48, slack/lark-panel
+4 → channels ≈ 4065.

### Step 3 — web → IM handoff

**Files.** `channels/handoff.ts` (new), `channels/routes.ts`,
`channels/runtime.ts`, `channels/types.ts`, `channels/conversations.ts`,
`channels/slack.ts`, `channels/slack-outbound.ts`, `channels/lark.ts`,
`channels/lark-outbound.ts`, `channels/lark-api.ts`, `core/router.ts`,
`main.ts`, `web/server.ts` (one identifier), `web/ui/session-header.ts`,
`docs/design/03-web-workbench.md`, `04-im-channels.md`, `architecture.md`,
`skills/pier-help/SKILL.md`, tests.

New module `channels/handoff.ts` — one reason: the only code that binds an
existing session to a thread it did not create, and the only root message
Pier ever posts; neither belongs to an adapter (`slack.ts` is over its
ceiling) nor to the Console config routes.

**Seams.** No change to `Channel` or `AgentSession`. Opening a thread is a
channels-internal operation: `ChannelRuntime` already holds concrete adapters.

```ts
// channels/types.ts
export interface HandoffTarget { platform: ChannelPlatform; chatId: string; name: string; kind: ChatKind }
export interface HandoffRequest { sessionId: string; platform: ChannelPlatform; chatId: string }
export interface HandoffResult { conversationId: string }
/** Title and link only — never conversation content. `url` "" when no public URL is set. */
export interface HandoffNote { title: string; url: string }
```

```ts
// channels/runtime.ts
interface ImChannel extends Channel {
  /** Post the handoff root in `chatId`, return the new conversation id. */
  openThread(chatId: string, note: HandoffNote): Promise<string>;
}
running(): ChannelPlatform[];
openThread(platform: ChannelPlatform, chatId: string, note: HandoffNote): Promise<string>;  // throws `${platform} is not running`
```

```ts
// channels/slack-outbound.ts
async open(channel: string, note: HandoffNote): Promise<string /* ts */>   // postMessage, no thread_ts, mrkdwn per §2
// channels/slack.ts
openThread = async (chatId, note) => conversationId(chatId, await this.out.open(chatId, note));

// channels/lark-api.ts  (LarkClient)
/** The one root Pier posts: a handoff's thread has no user message to reply to. */
createCard(chatId: string, card: LarkCard): Promise<{ messageId: string }>;   // im.v1.message.create, receive_id_type "chat_id", msg_type "interactive"
// channels/lark-outbound.ts
async open(chatId: string, note: HandoffNote): Promise<string /* root */>   // createCard, then replyCard(root, "Reply here to continue.")
// channels/lark.ts
openThread = async (chatId, note) => conversationId(chatId, await this.out.open(chatId, note));
```

`replyCard`'s comment "the only way to post" becomes "the only way to reply;
`createCard` is the one root". `04-im-channels.md` "Deliberately not features
… posting in a Slack channel's main flow" gets the clause "except the single
root message a web → IM handoff opens its thread with".

```ts
// channels/conversations.ts
keyOf(sessionId): ConversationKey | undefined;   // replaces channelOf; main.ts:322 and web/server.ts use keyOf(id)?.channelId
```

```ts
// channels/handoff.ts
export interface HandoffDeps { store: ChannelStore; runtime: ChannelRuntime; conversations: ConversationStore;
  factory: Pick<AgentFactory, "find">; router: Router; hub: EventHub; publicUrl: () => string; log(m: string): void }
export class HandoffError extends Error { constructor(readonly status: 404 | 409 | 502, message: string) }
export function createHandoff(deps): {
  targets(): HandoffTarget[];                                  // running platforms × enabled chats
  continueIn(req: HandoffRequest): Promise<HandoffResult>;
}
```

`continueIn` in order: platform running (409) → chat known and enabled (404 /
409) → `factory.find(sessionId)` (404) → `conversations.keyOf(sessionId)`
(409 `already answers in <platform> · <chat name>`) → title =
`readableTitle(summary.title) || basename(summary.cwd)` (the rule `push.ts:33`
uses; hoist that one-liner to `core/identity.ts` beside `readableTitle` and
delete the copy) → `runtime.openThread` (502 with the platform's message) →
`conversations.set(key, sessionId)` → `router.sessionOf({web, sessionId})`
and, if loaded, `router.attach(key, session)` → `hub.emitWorkspace({type:
"sessions-changed"})`. Post before row: a row for a thread that does not exist
is worse than a message with no row (Risks).

```ts
// channels/routes.ts
GET  /api/handoff/targets → 200 { targets: HandoffTarget[] }
POST /api/handoff         body HandoffRequest → 201 HandoffResult | 400 invalid body | 404 | 409 | 502 { error }
```

`registerChannelRoutes(app, store, runtime, handoff)`.

```ts
// core/router.ts — constructor
private readonly chatKeyOf: (sessionId: string) => ConversationKey | undefined = () => undefined,
```

In `attach()`, fresh branch, after `bySession.set`: if `isAlias(key)`, look
up `chatKeyOf(session.id)`; if found, `byKey.set(keyOf(chat), session)` and
`attached.key = chat`. Comment: *the durable chat outranks the alias that
happened to open the session first (a restart, the web speaking first), same
rule as `reached`.* `main.ts:119` passes `(id) => conversations.keyOf(id)`
beside `sessionIdOf`. This also closes a pre-existing gap: an IM-born session
opened from the web after a restart did not answer in its thread until the
thread spoke.

**Web UI** (`web/ui/session-header.ts`, ~55 lines, no new module): menu item
+ `handoffPicker(anchor, s)` built on `openPanel` with `MenuItem`-shaped rows
(the `dir-picker.ts` pattern); `getJson<{targets}>("/api/handoff/targets")`;
`sendJson("/api/handoff", …)`; error under the row. Disabled row when
`s.channel !== "web"`. Same panel at both widths; rows are `min-h-10`, 44px
targets on coarse pointers as menus already are. Add the item to
`03-web-workbench.md`'s menu list and routes table.

**Failure paths.**

| Case | Web sees | Chat sees |
| --- | --- | --- |
| Platform disabled / not running | `Lark is not running — enable it in Settings → Channels.` | — |
| Chat unknown or disabled | `That chat is not enabled for the bot.` | — |
| Session not on disk (never prompted on the web) | `Session … has no transcript yet — send it one message first.` (404) | — |
| Already bound | `Already answers in slack · #ops.` (409); row disabled beforehand | — |
| Platform API refuses (scope, bot not in chat) | `lark message.create: 99991672 …` (502), nothing written | nothing posted |
| Root posted, Pier dies before the row | rail unchanged; retry posts a second root | first root's thread: a reply is a *new* session (DM) or dropped unaddressed (group) — the message text still points at the web |
| Reply in the handoff thread while Pier is down | — | answered on restart? No: Lark/Slack redeliver only within their windows; same as any thread today |

**Restart.** Row is the truth. Thread speaks first → `knows` → `ensure` →
resume → attached under the chat key. Web speaks first → `ensure(web)` →
resume → `attach(web)` → `chatKeyOf` → delivery to the thread. Task alias
first (`task:<id>` callback) → same hook; a chat outranks an alias as before.

**Tests.**

- `core/router.test.ts`: `an alias open attaches the session's durable chat
  key and turn-end reaches that channel`; `a later alias reach does not take
  the key back`; `no chat key → alias behaviour unchanged`.
- `channels/conversations.test.ts`: `keyOf finds the thread of a session and
  undefined otherwise`.
- `channels/handoff.test.ts` (new): the six failure rows above plus the happy
  path (`posts once, writes the row, attaches when loaded, emits
  sessions-changed`), `does not write a row when the post fails`, `title falls
  back to the directory name`, `no public URL → empty link, message says so`.
- `channels/runtime.test.ts`: `openThread on a platform that is not running
  throws by name`; `running() lists live adapters`.
- `channels/slack.test.ts`: `openThread posts a root without thread_ts and
  returns <channel>/<ts>`; `a reply in a handoff thread without a mention is
  admitted in a mention-required channel`.
- `channels/lark.test.ts`: `openThread creates a root card then one in-thread
  card and returns <chat>/<root>`; `a topic reply to a handoff root without a
  mention is admitted`; `lark-api.test.ts`: `createCard sends receive_id_type
  chat_id and interactive`.
- `channels/routes.test.ts`: the two routes, status codes, invalid body.
- Web: no unit harness for menus; the manual test in §5 covers it.

**Delta.** handoff +70, routes +30, runtime +18, types +14, conversations
+6/−8, slack +3, slack-outbound +12, lark +3, lark-outbound +14, lark-api +14
→ channels ≈ 4240: **over the 4.2k ceiling by ~40 lines.** The sentence for
the raise, if the Step 1–2 deletions do not cover it: *the handoff is the one
cross-surface binding and the one root post, and its failure table is
principle 5's, not padding.* core +7 (1385/1.5k), web +55, root +6
(3211/3.25k).

## 4. Open questions for the operator (defaults in bold)

1. **Lark: root card plus one in-thread card** (a topic on the phone has its
   own composer only once it has a reply; a bare root needs long-press → reply
   in thread) **vs one root only** as the brief says. Default: two; drop the
   second if the first phone test shows a topic affordance on the bare root.
2. A session that already answers in a chat (IM-born, or handed off before):
   **refuse with the chat's name** vs move (delete the old row, `forgetKeys`
   the old thread). Default: refuse; moving is a later, separate decision.
3. Recent directories: **6, from every session on disk including task runs'**
   vs excluding task sessions (needs `tasks → channels` knowledge control does
   not have). Default: include.
4. Opening the panel on an evicted thread **resumes the session** (one Pi
   open, truthful values) vs a third "not loaded" state with no model shown.
   Default: resume.
5. No public URL configured: **post the handoff without a link and say
   `(no public URL set — Settings → Instance)`** vs refuse the handoff.
   Default: post.

## 5. Risks, and the first manual test on a real phone

Risks.

- Lark `im.v1.message.create` needs `im:message:send_as_bot`; the app may not
  have it. The 502 names the code; the manual test decides whether the scope
  is added or the feature is Slack-only for now.
- Lark DM: a user who types in the DM's main flow instead of the topic starts
  a *new* session (today's rule for every DM). The root card's last line is
  the only guard; Q1 exists to soften it.
- Post-before-row window (crash between the two): an orphan root that promises
  a thread nobody owns. Rare; the text points at the web either way.
- The `launch` record outlives its purpose once a transcript exists; it is
  read only on a failed resume, so a session that lost its file re-creates
  with its last model rather than the chat default — better, but a change of
  behaviour named in the stale note.
- Pre-existing, unchanged: *New session* on a thread whose old session is
  mid-turn leaves the old session attached under the same key until eviction;
  its turn-end still posts into the thread. Out of scope, noted.
- `channels/` will sit at or just over its ceiling after Step 3 (§3).

First manual test (Lark on the phone, after Step 3; Steps 1–2 have their own
smaller version — bare `@bot` in a fresh topic → *New session in…* → pick a
directory → *Model* → ask the operator to restart Pier → reply in the topic
without a mention → the reply runs in the chosen directory with the chosen
model; the panel shows the same session id or the re-created note).

1. Desktop: open a web session with two turns, ⋯ → *Continue in Lark/Slack…*
   → `Lark · DM · Qi`.
2. Phone: a notification arrives; the DM shows the root card with title and a
   working link; the in-thread card exists; the rail row on the desktop shows
   the `l` chip.
3. Phone: reply in the topic (no mention). Desktop: the message appears in the
   web timeline; the reply appears in both places with a footer.
4. Desktop: send a message from the web. Phone: the reply lands in the topic
   (not the main flow); no web push arrived.
5. Ask the operator to restart Pier (`systemctl --user restart pier` is theirs
   to run). Desktop first: send a message → the topic gets the reply
   (`chatKeyOf` on alias open). Then phone: reply in the topic → answered.
6. Desktop: *Continue in Lark/Slack…* again on the same session → row disabled
   `answers in lark`; force the POST with curl → 409 naming the DM.
7. Repeat 1 on a Lark *group* the bot is in with require-mention on: no `@`
   in the root, replies without a mention are answered.
