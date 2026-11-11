# Continuous session

The contract for the instance's Pier head, which routes work to task-run
children; every chain (§Chains) has one. Behaviour not named here is
[03](03-web-workbench.md)'s, [04](04-im-channels.md)'s and
[09](09-tasks-cli.md)'s; what is not built is §Not built.

## Roles

The behavioural contract of each role is `agent/roles.ts` (`DISPATCHER`,
`lead(phase)`, `WORKER`); this section holds what code enforces. The **head** answers, remembers
and launches work; real work is a task-run child, and callbacks are the only
delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| head | the newest session; a chain's first head and a lost head's replacement on the instance default model (the operator sets it to the `balanced` pin) at `low`, every later one on the previous head's | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life
  (`createdRole`, `TaskStore.roleOf`); when its session appears in the status panel is
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).
- The preamble runs general to specific: Pier's baseline with the chat
  surface (`surfacePrompt`, after `# Working style`; a worker's is the reply
  language and the instance's facts alone), the user's `SYSTEM.md`,
  then the role contract, its last block (`pierSystemPrompt`, `agent/pi.ts`);
  the project context holds only real files, the cwd's `AGENTS.md` then
  `AgentLaunchOptions.contextFiles` (a missing one skipped, an unreadable one
  loaded as `(could not be read: …)` and logged).
- Each contract opens `# You are …` and ends its opening paragraph on
  `ROLE_GUARD`: a project's or a chain's `AGENTS.md`, read after it, never
  lifts one of its "never"s.
- A worker opens without the `pier-tasks` skill and with `WORKER`, its chat
  surface without buttons and attachments; a lead with `lead(phase)` (the
  Design or the Build section, its phase passed on `AgentLaunchOptions.phase`);
  neither on disk. A reopened session gets its role, phase and context files
  back from the factory's `roleOf`.
- A lead's run whose result carries a `Design final: <absolute path>` line
  owes the head a callback (§Milestones); the head launches a new build lead on
  the doc in the design lead's worktree (`--cwd`, no `--worktree`), so it builds on
  the design's branch toward its target, its prompt opening `Build per `.
- A design lead's turn outside any run (the user confirmed in its session)
  that carries the line is recorded as a finished run of the lead — reuse,
  resumed from its latest run, that run's callback target, the reply its
  result — so it reports and clears the same way (`TaskService.designFinal`,
  on `Router.onTurnEnd`); a failed turn, a run's own turn and a build lead's
  record nothing.
- A run's `--name` is its session's title; a lead's session carries its
  phase (`TaskStore.leads`): `design` when its creating run carries
  `launch.design` (`--design`, set by the head only for a product or architecture
  design the user finalizes), `build` for any other lead.
- A code change runs build → review → merge; the head merges unasked.
- A worker launched `--worktree <branch>` (or `--rounds <n>`, n ≥ 1) is the root of a goal (`tasks/goals.ts`, [09 §run](09-tasks-cli.md#run)); a lead's review of its integrated branch is such a goal in its own worktree (`--rounds <n> --cwd <its tree>`); its done milestone names the sha that goal ended clean on.
- The head's code worker is reviewed up to 3 times for a feature, a small or follow-up fix or a mechanical change once (`--rounds 1`), a purely mechanical edit never (`--rounds 0`) (`DISPATCHER`).
- A follow-up — the user's answer, a review fix, a small addition to the same change — continues its run (`DISPATCHER`). `--run <id> --fresh` continues it in a new session Pier briefs instead ([09](09-tasks-cli.md#continuing-a-run)), its prompt what was tried, where it failed and the new direction, when one problem has failed 2 fixes, the run is stuck or the direction changes (approach overturned, another module); a compacted or near-full session gets one unasked. A model change is a new run, `--cwd` the old worktree (with `--rounds <n>` for a goal).
- A lead integrates workers into its own branch (`git merge <branch>` in its worktree, their worktrees kept) and never merges into the target; its done milestone ends on the branch ready and names the worktrees left.
- A clean review's behaviour and readability P2s go back to its root run in the branch (`--rounds 0`, the project's checks only); the head merges once it is green, or at once with none (`DISPATCHER`).
- The merge into the target and every worktree's removal are the head's; no build session runs `wt merge`/`wt remove` or is resumed to. The head merges itself, unasked (`DISPATCHER`): HEAD the clean review's sha, or past it only by the in-branch P2 fix, a conflict fix or a wording fix the user named, and the tree clean, then `wt -C <worktree> merge --no-squash <target>`, removing the worktree unless they keep it, then the project's checks on the target if HEAD was past the reviewed sha or the merge printed `Rebased onto` (the review ran them on the reviewed sha only). A small conflict goes to a run, the project's checks green, then the head merges; only a conflict needing a choice between approaches asks the user. A red check after the merge goes to a run fixing it on the target. Restart and deploy stay the user's.
- The branch's commits land as they are, rebased onto the target: a worker squashes its WIP and fixups and writes each message per the project's conventions before its run ends (`WORKER`), a fix round folds into the commit it corrects (`fixPrompt`), and a goal's review reads `git log` and finds a WIP or fixup commit or a message off the project's conventions, a P1 (`reviewPrompt`); `wt merge` takes no message and its squash writes its own, so nothing squashes at the merge.
- Models are `MODEL_TABLE` (`agent/roles.ts`), carried by `DISPATCHER` and `lead("build")`.
- A rule has one owner, the lowest layer every reader of it loads: the reply language is `surfacePrompt`'s, what stops a run and the `Approved:` line lifting it the baseline's Working style (`agent/pi.ts`), the result's shape `RUN_RESULT`'s, the merge being the head's `DISPATCHER`'s — `WORKER` and `lead("build")` carry it as one clause.

### Prompt vocabulary

The role contracts, `reviewPrompt`, `fixPrompt` and Pier's `[Pier: …]` notes use one word per concept; a sentence holds one rule, names who acts, and stays within ~25 words.

| Word | Means | Not |
| --- | --- | --- |
| user | the human in the conversation | them, the requester |
| conversation | the continuous conversation: the main session and every session before it (`main_chain`) | series |
| chain | one continuous conversation of its own: a name, its sessions, memory and items | session, topic, channel |
| main session | the continuous conversation's current session, "you" in `DISPATCHER` | head (code and docs only), dispatcher |
| supervisor | the session that launched a run and reads its result: the main session or a build lead | the agent that delegated it, parent |
| run | one `pier task run` and the agent working it; `worker` or `lead` when the role matters | child, job |
| launch | start a run; the main session's launch is a dispatch | delegate, spawn |
| result | a run's final reply, read verbatim | report |
| reader | whoever reads a result: the supervisor, else the session it is delivered to or the operator | — |
| owed | a result is owed to a session while a run whose callback names it is in flight | due, pending |
| milestone | a lead's reply to the last result owed to it, which its supervisor reads | — |
| goal | a worker run reviewed and fixed until clean, from its root run | loop |
| item | one `<open>` entry: its problem is the key, its stage where it stands | task, topic |
| phase | a lead's: `design` or `build` | stage |
| default | `MODEL_TABLE`'s missing `--thinking`: the tier's own level | the pin |
| charter | a chain's `chains/<id>/AGENTS.md`: the user's standing instructions for it — focus, default repo, skills, models | profile, chain prompt |

### Milestones

Every run or group callback owed to a lead session asks `TaskService.milestone`
(the `Deliverable.milestone` hook, `tasks/outbox.ts`):

- another result still owed the lead (a run in flight whose callback, or whose
  unfinished group's, names it): a plain callback, a lead turn outside any run;
- the result that leaves nothing owed: resumes the lead's last run, prompted
  `[Pier: the last result owed to you follows; …]` (`MILESTONE`), and that run's
  callback reaches the head once; the resume and the `delivered` marks commit in
  one transaction;
- the lead's last run still running: pending, asked again in 10 s;
- nobody waiting on that run, or a resume that cannot be filed (logged): plain.

A lead's own run owes the head a callback only when it was a milestone resume,
its result carries a `Design final:` line, it is a build lead's and leaves no
result coming to it (`TaskStore.awaitsResults`), or it did not succeed; otherwise it settles as
`--callback none` does, `LEAD_TURN` (`tasks/callbacks.ts`) the reason on its record.

## Home and memory

- `$PIER_HOME/home` (`pierPath("home")`) holds memory only, in two layers,
  each an index `MEMORY.md` (one-line facts that hold across days, kept under
  its 4K seed budget by the head — a detail goes to a note or the repo's
  `AGENTS.md`) and daily notes `memory/YYYY-MM-DD.md` (local date):
  - global, `MEMORY.md` and `memory/`: the user's preferences, facts true
    across topics, ways of working, asks of Pier; every chain seeds it;
  - chain, `chains/<id>/MEMORY.md` and `chains/<id>/memory/`: that chain's
    decisions and why, backlog, external facts in use; only its own heads
    seed it, the others reach it by `rg` or `pier search`.
  The user's instructions are layered the same way, beside the memory: an
  optional global `AGENTS.md`, Pi's, loaded as the cwd's own (every head's cwd
  is `home`), and a chain's charter `chains/<id>/AGENTS.md`, loaded after it
  by that chain's heads only (`AgentLaunchOptions.contextFiles`, from
  `MainChain.rotate` and on a resume from the factory's `roleOf`), so two
  chains' head prompts differ by their charters alone. A charter applies from
  the chain's next head, and sooner on a head Pier reopens (`factory.resume`
  after a restart, `pier reload` or the router's idle eviction), which reads
  it again; the web's Charter dialog writes it (4000 chars at most) or the
  head edits it when asked; the runs it launches never load it.
- A head reply's `<note>line</note>` is stripped like the open-item markers
  and appended as `- line` to today's `chains/<id>/memory/YYYY-MM-DD.md` of its
  chain, `<note global>line</note>` to today's `memory/YYYY-MM-DD.md`, on its
  `turn-end`, from the answer and the turn's `earlier` text alike
  (`MainChain`'s `Router.onTurnEnd` listener, `core/chain.ts`); a
  failed write is reported to the head's conversation with the lost lines.
- A note keeps a decision and its why, a user preference, an external fact or
  live check, a step the user owes; research is its conclusion and run id. It
  never records merge, push or restart state or a run's tool counts (git, run
  records and `pier task stats` hold them); an overturned line is replaced,
  not appended (`DISPATCHER`).
- `DISPATCHER` is the preamble's role contract (`agent/pi.ts`) only for a
  session whose real cwd is the home.
- Repo knowledge goes in that repo's `AGENTS.md`, written by a child. Recall
  is on demand: a message pointing at earlier work (a name, a date, "what we
  decided") is one fetch before the answer — `rg <q> memory chains/*/memory`
  for a note (indexes `chains/*/MEMORY.md`), `pier search --in main <q>` over
  what the user and Pier said in every chain (a `<note>`'s
  words match through the reply that wrote it); `--since` narrows a time such
  as last week ([08](08-cli-socket.md)); no vector store, and only the newest
  notes are seeded (`DISPATCHER`).

## Chains

`core/chains.ts` is the register (names, archive, `resolve`); `MainChain`
(`core/chain.ts`) runs one head, queue, seed and chain memory per chain. The
product behaviour is [plans/30](../plans/30-multi-chain.md).

- Chains are always on: an instance with one chain lists one row.
- A name is 1–40 characters, trimmed, not a `/chain` verb (`new`, `rename`,
  `archive`), unique among the active chains in any case; the id names the
  memory directory and survives a rename. The migration's chain is `main`,
  named `Main`.
- The first chain is the active one created first; whatever no chain claims
  lands there.
- An archived chain takes no user message (`chain: <name> is archived —
  unarchive first`), only `/chain` and `/chain rename`; its runs finish, its
  callbacks reach its head, its items show marked archived, its memory stays
  searchable.
- An item belongs to the chain of the head that wrote it, a run to its
  launcher's chain; a `conversation` callback reaches
  `headOf(run.invokedBySessionId)`, a scheduled task's
  `headOf(createdBySessionId)`, else the first chain's head.
- Another chain's matter gets one line pointing at `/chain <name>`, or an
  answer after `pier search --in chain:<name>`; its item is never opened here
  (`DISPATCHER`).
- `pier search` without `--in` answers the caller's chain first, then the
  other chains, then every other session; a chain member's hit is placed by
  its chain's name (`core/search.ts`, `skills/pier-search`).

`/chain` is a chat command on a head (home DM, web); in any
other thread it is prose. `chatCommand` returns `{ command, args }`.

| Command | Answer |
| --- | --- |
| `/chain` | one line per chain, `<name> · N open · M waiting on you`, `✓ ` before the current, archived last with `(archived)` (`MainChain.chainsText`); on a chain with no head yet, or archived, the surface shows it (`ChainSent.answer`) and no head starts |
| `/chain <name>` | switch to the one name holding every word, any case (an exact name first), archived refused; ambiguity answers `/chain <q> matches A, B — say more`; never rotates |
| `/chain new <name>` | create and switch |
| `/chain rename <name>` | rename the current chain, answered as `/chain` is |
| `/chain archive` | archive the current chain and switch to the first; refused while it has open items (`chain: <name> has N open — /status first`) |

## Head lifecycle

| Event | Rule |
| --- | --- |
| User message, head ≥ 1h (`CHAIN_IDLE_MS`) since the user was last in the exchange — the later of its last user message and the completion of its last reply that reached them (a non-silent turn answering a user message, or the result of a run a chain member launched; a cron or watch run's report never counts) — or its start | rotate first: create the next session, append a chain row, deliver to it; a streaming head never rotates |
| User message, head past `CHAIN_FULL_TOKENS` (60K) | rotate first, reason `full`, the seed pointing at where the previous head left off; `null` usage (right after a compaction) never rotates |
| Head gone from Pi (not live, not on disk) | a new head, reason `lost`, at the next send or the next web read of the head; the gone head leaves `main_chain` |
| Rotation | a rotated or `/new` head keeps the previous head's model and reasoning, as the user last set them from the web or IM; a `first` or `lost` head starts on the Settings default, read then (unset: Pi's model at `low`); it gets one `session-seed` system input, mode `append` (no turn), and joins `main_chain` only once that lands |
| Seed | a first line naming the chain and its memory paths, `MEMORY.md`, `## chains/<id>/MEMORY.md`, `## Open` (§Open items' complete seed projection over this chain's items, `Nothing open.` included), `## Chains` (only with two or more active chains: one line per active chain, `<name> · <N> open · <M> waiting on you`, this one marked `(this one)`), the run ledger since the previous head started less its `succeeded` and `skipped` runs (`pier task runs` shows those), one line per run `<runId> · <name> · <state> · session <id> · <cwd>`, the newest notes — the last 1K chars of global `memory/*.md` and 2K of `chains/<id>/memory/*.md`, each by whole lines, newest day first collected backwards across days until the budget is full, each day's lines under its own `## memory/<date>.md` heading so the head sees how old the latest is (a week away leaves it the week's last state, not an empty day) — and on a `full` rotation only `## Previous session`: `session <id>, last on <item> at <YYYY-MM-DD HH:MM>` — `<item>` the `replyTopic` of the previous head's last reply, `none` when it had none, the time its `completedAt` in local time — and the replay command `pier search --in <id> --around "<time>"`, never its exchanges (the user was mid-subject; an `idle`, `new` or `lost` head starts without the previous subject); older notes are never seeded — recall is on demand (§Home and memory); an unreadable file says so; each part is cut to its budget: each `MEMORY.md` 4K chars from the end (`core/reply.ts` `cut`, the ellipsis its mark), the ledger 4K the same way (newest first, so the oldest go), the notes as above, headed by `… <N> lines omitted, the rest in memory/<date>.md`; `## Open` is bounded by its own rule — about 8K tokens at most; built before the session is created, so a seed that fails creates nothing and fails the send with its reason; opens with `[lang=<code>]` when the previous head's users spoke a detectable language, so a callback landing before anyone speaks to the new head is stamped with it ([04 §Who is speaking](04-im-channels.md#who-is-speaking)) |

- Rotation is lazy, only on a user message, so a head fed by callbacks alone
  grows to its compaction cap, the backstop; no timer. `MainChain.send` runs
  one at a time per chain, so a race rotates once and chains never wait on
  each other; idle counts from the chain's own last exchange — the user's
  message or the reply they saw, so a button pressed on the answer to a run
  it dispatched hours after the last question stays in the session that
  asked, while scheduled reports alone still let it roll over; `/new`
  rotates the current chain.
- Compaction, decided at open (`agent/pi.ts`): a
  session in the home at 100K, a worker's at 180K, a lead's at 200K (the
  price tier; a lead's state is its doc), any other at the instance's
  setting; `reserveTokens = window − cap`, never later than the instance's
  reserve, recomputed on `setModel`. Children never rotate.
- `ContextUsage.compactAt` is that point, and a child's header reads against
  it; the head's bar shows the used tokens, Session info `used/rotateAt` (`CHAIN_FULL_TOKENS`).

### Cache

- The head's system prompt is the same bytes every turn: the clock and the
  sender ride the user message, the ledger the seed.
- A head keeps its model and thinking for its life and hands them to the next head; Settings start only a chain's first head and a lost one's replacement.
- Every system input appends; the head requests the 1h TTL, which is
  `CHAIN_IDLE_MS`.
- Accepted one-time misses: a rotation, a settings change that edits the
  prompt (skills, the home's `AGENTS.md`), the user switching model, and an
  upgrade that reorders the prompt — a session opened before it has its
  `preamble` and `project_context` resent once on its next request.

## Open items

- The head keeps the list inside its replies: `<open>problem — stage (run <id>)</open>`
  adds, replaces or reopens the item keyed by `problem`, `<done>problem</done>` closes it;
  both are stripped beside `<silent>` and never read inside a code span or a fence,
  indented or not (`openItemMarkers`, `core/reply.ts`); when to write them is `DISPATCHER`'s.
- A marker's body is read apart (`openLine`): the `(run <id>)` and
  `(runs <id>, <id>)` tokens that end it are its run ids, in order — an id is
  one word with no whitespace, parenthesis or comma, so `(run the tests)` is
  text. One before them is a token only when every id in it has a ledger id's
  shape, sixteen of `[0-9a-z]` (`LEDGER_ID`): `(runs nightly)` in a stage is
  the stage's words. With the tokens out, the key is the text before the first
  spaced em-dash run (` — `, ` —— `), else before the first bare `—`, and the
  stage the text after it.
  `<topic>` and each side of a `<done>` arrow are read the same way.
- A marker's body never holds its own tag's opener: in `<done>a <done>b</done>`
  only `<done>b</done>` is a marker. A marker whose opener starts the reply's
  last non-empty line — only whitespace before it — and that its own closer
  does not close is read to the line's end or a `<silent>` on it, a wrong
  closer dropped, and logged;
  one left open on an earlier line or after other text on its line is text,
  neither read nor stripped: markers are taken out before `<silent>` is.
  An answer cut short — an abort, the provider's length cap (`turn-end`'s
  `partial`) — has that last marker read as none: stripped, never recorded,
  and no opener before it read as the last line's in its place (`cutUnclosed`);
  so has the turn's `earlier` text, always.
- The arrow is ` → ` alone (`ARROW`, `arrowOf`), split at its first
  occurrence with both sides non-empty: `<done>old → new</done>` is the marker
  `{problem: old, to: new, whole}`, `whole` the body read as one key. A
  `<done>` whose key only a bare `—` cut carries the uncut body as `whole` too.
- A turn's markers are its answer's and its `earlier`'s, `earlier` first:
  the text of the turn's tool-calling assistant messages before the answer
  (`turn-end`'s `earlier`, gathered by `PiSession.subscribe`;
  `Router.onTurnEnd`'s fourth argument). `<topic>`, the visible reply, the
  title and the silent reading take the answer alone.
- A dispatch is a silent reply beside its `<open>` marker, the chat's run tag
  its receipt; it speaks one line only for a choice made for the user or
  a run that is long or needs them.
- A reply about an item names it: `<open>`/`<done>` does, any other reply ends
  with `<topic>problem</topic>`, the same key — one written like an `<open>`
  line still keys on the problem, its stage and run tokens dropped; stripped like
  the rest, never painted mid-stream (`streamTail`), read by `replyTopic` (`core/reply.ts`) — the tag the web chat labels rows with
  ([03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts)); IM shows
  nothing of it.
- The head's `turn-end` writes them (`TaskService`'s `Router.onTurnEnd`
  listener, when the session is `members()[0]`; `TaskStore.markOpenItems`),
  arrows after every other marker, and broadcasts `open-items-changed` when a
  row changed; a marker with no problem is logged and dropped.
- `<open>` of an open key replaces its stage, and its runs only when it names
  any: one with no run token keeps the item's runs, and a key holding none
  takes those of the open `old` an arrow closes into it. A closed key reopens with
  the marker's runs. An `<open>` whose key holds an arrow, the whole key not
  open, its `old` exactly an open key and its `to` another, is
  `<open>to — stage (runs)</open>` with `<done>old → to</done>`, and one whose
  `to` is an open key holding `old` as an alias is `<open>to — stage (runs)</open>`;
  `to` then holds the key as written as an alias. Any other key with an arrow
  is stored as written.
- `<done>` without an arrow closes the open item keyed by it, else the one
  open item whose key is it followed by `。` `:` `：` or a spaced `-` or `–`
  (`namesKey`; an `<open>` written without ` — ` keyed the whole line), none
  when two are. One that closes nothing is already settled — no change, no
  miss — when it is the key or an alias of a closed item of the chain and an
  alias of no open one. Its `whole` goes first: an open key closes, and one
  that is any item's key or alias is settled or a miss by the same rule, the
  cut key not tried.
- `<done>old → new</done>` whose `whole` is an open key closes that item. Else,
  `new` an open key holding `whole` as an alias, it closes `new` — the head
  repeating the key it wrote — and is already settled when another marker of
  the turn names `new`. Else, `old` read as above, `new` not among its
  candidates, and `new` another open key, `old` closes into `new`
  (its key, aliases and sessions, [15](15-item-view.md#items-keep-their-record)).
  Else, `old` not open and `new` open, it is already settled when `new`'s
  aliases hold `old`, or when `old` is a closed key of the chain, which `new`
  then absorbs. Else it is already settled when `whole` is the key or an alias
  of a closed item and of no open one.
- Any other `<done>` is a miss, logged. While an item is open, a turn with a
  miss gets the note `[Pier: <done>X</done> closed no open item. If it meant
  one of these, resend <done> with that key exactly; if its item is already
  closed, send nothing:` and the open keys as a `- key` list, an arrow into no
  open item adding `("new" is not open)` (`unmatchedNote`); its origin carries
  the list as `statusSnapshot`.
- A head turn opened by a run's result (the `task-callback` origin of the
  input that opened it, `Router.onTurnEnd`'s `opened`; a steer's is the
  answer it opens on entering) that left an item holding a run of that run's
  session with no live run, its exact key — or an arrow's `whole` — in none of
  the turn's markers, gets the note `[Pier: run <id> ended; open item "<key>"
  still has its old stage. Close it with <done>, or <open> it again with a
  stage saying waiting on you.]` (`staleNote`).
- A turn's notes go as one `open-items` system input with `turn: true`, mode
  `followUp`: the head answers it in a turn of its own, at once or after the
  running one. It is mode `append` without `turn` when the turn itself was
  opened by an `open-items` input, or when its text equals the last note sent
  to that chain (one per chain, in memory, forgotten when a head turn of the
  chain ends owing no note).
- Pi answers a follow-up queued at a turn's end in the same run; the note
  enters it with a `turn-start` of its own, so it is that answer's `opened`.
- The misses stay owed, in memory: a reply that closed an item owes only its
  own, one that closed none the newest 5 of the owed and its own, deduplicated;
  nothing open owes none, and a user's close drops those naming its key. The
  seed's `## Open` lists them as `- unmatched <done>: X (closed nothing; if it
  meant an item above, <done> that item's key)`, `/status` under
  `Unmatched done` (`OpenItemsSnapshot.unmatched`).
- The user closes an item too: `/done <item>` (§Chat commands) and the status
  panel's **Close** both call `TaskService.closeItem`, which closes it as a
  `<done>` does (`TaskStore.closeOpenItem`) and broadcasts `open-items-changed`.
  `/done` resolves its words among the chain's open keys — exact in any case,
  else the one key that contains every word, in any case; several are refused `/done <q> matches <a>, <b> —
  say more`, none `no open item "<q>"` (`ItemNotFound`) — and **Close** names its
  key exactly, answering `{closed}` for a key the head's `<done>` closed first.
  The chain's head, when attached, is told with an `open-items`
  system input, mode `append`, no turn: `[Pier: the user closed <key>]`.
- The reply the head was writing when the user closed an item does not bring
  it back: once its markers are written, each item closed during the turn is
  closed again when the reply reopened its key, or opened an item not open
  before it that holds that key as an alias or shares a run's session with it
  (`closedMidTurn`, the turn's only: a turn that fails takes its closes with
  it, read off the session's event stream).
- A head whose context is compacted while an item is open — a run in no item
  is none — gets
  `[Pier: the context was compacted. The open items as they stand, keys exact:]`
  and the seed, an `open-items` system input, mode `append`, no turn, with the
  chain's `statusSnapshot` (`MainChain`, `Router.onCompacted`); a send that
  fails is reported to the conversation.
- The owed misses, the mid-turn closes and the last note live in memory: a
  restart loses a reminder, never an item.
- Items list in creation order (`TaskStore.openItems`); an `<open>` that
  replaces an item keeps its place.
- A session is behind one item: an `<open>` takes its run tokens, and every
  run of their sessions, off every other item (`TaskStore.markOpenItems`); the first one left with no run is renamed to
  the new problem in its place, the rest are closed into it, and one that still has
  other runs keeps them.
- A closed item keeps its row (`closed_at`, its `aliases` and the head `sessions`
  that wrote it, [15](15-item-view.md#items-keep-their-record)); every read of the
  list — `TaskStore.openItems`, the seed, `/status`, `GET /api/continuous/open`,
  `namesKey` — is the open ones, and a reopened item takes the list's end.
- `TaskService.openItems()` (`tasks/open-items.ts`) resolves each run token to its session
  (`TaskStore.getRun`) and shows that session's newest run (`latestRunForTarget`),
  however old, so a lead woken again stays the same item; a token naming no run
  reads `run <id> — not in the ledger` (`NOT_IN_LEDGER`); a lead run's carries all
  its launches counted by state (`workerCounts`); `unlisted` is the chain's queued
  and running runs in no item's session; no listing window or cap applies.
- Optional `title` comes from the session's creation run, independent of the newest run's name: reuse the existing lead read and batch other involved sessions through `TaskStore.creationTitles`; absent creation records fall back to a valid run name, then problem, on every surface.
- A design lead is an item only through the head's `<open>` naming its run; `<done>` is its end.
- Optional `designSessionId` is the first associated run target whose design lead has not reported `Design final:` (`TaskStore.leads` `designOpen`), independent of status or `waitsIn`; it changes navigation only.
- Each item's `status` is `openStatus` (`tasks/open-items.ts`), the one reading
  of its run tree — each run, its session, a lead's workers (workers never
  delegate, so that is the whole tree) — and its stage; first match wins:

  | status | when |
  | --- | --- |
  | `running` | a run's goal live; else a run `queued`/`running`, its session streaming, or a lead's worker `queued`/`running` |
  | `waiting on you` | a run's goal ended `decision` or `cap`; else the stage says `waiting on you`, or a run's session is a design lead not reported final whose newest run `succeeded` |
  | `wrapping up` | every run `succeeded` or carries a goal ended `done` (clean, the head merging unasked) |
  | `stopped` | a goal ended `failed`; else a run `failed`, `cancelled`, `interrupted` or `skipped`, or a token naming no run (`not in the ledger`) |

- A `waiting on you` item's `waitsIn` is the child session the answer is given
  in, from the same reason: a design lead not reported final → its session; a
  stage's `waiting on you` or a goal's `decision`/`cap` → absent, the chat.
- Only `waiting on you` asks anything of the user (`waitsOnYou`,
  `core/reply.ts`): `/status`'s first group, the status panel's first rows; a finished worker's outcome is read from its lead's run, not its own.
- An item is keyed by `problem` in the user's words; `stage` holds concrete phase, question and valid authorization, omitting ledger-derived run state, time and review rounds; only work in flight or waiting on the user's decision now belongs here, with backlog in MEMORY.md.
- A goal root's goal is read from the ledger (`TaskStore.goalOf`,
  by the run's session), never from the stage; a run queued in that session
  after the goal ended (the user's answer, the merge) carries it no more.
- `core/open-items.ts` builds the shared browser-safe presentation: title, status label, second line, metadata and run/session targets, runs newest first.
- The second line says what the user is needed for:

  | status | second line |
  | --- | --- |
  | waiting, answered in the chat (the stage says `waiting on you`) | `Needs you · <wait> · <question>`, the prefix dropped |
  | waiting on an ended goal, stage without `waiting on you` | `Needs you · <wait> · decision: <reason>`, `… · review cap reached · findings remain`; the goal wording leaves the metadata |
  | waiting, answered in the design session (`waitsIn`) | `Needs you in the design session · <wait>`, then ` · <stage>` when there is one |
  | running / queued | the stage; queued as `Queued · <stage>` |
  | wrapping up / stopped | `Wrapping up · <stage>` / `Stopped · <stage>` |

  Grouped cards and IM's `Waiting on you` group omit `Needs you`, keeping `in the design session`.
- A single queued/running run reads `elapsed <age>` from queuedAt; an ended run reads `<state> <age> ago`, replaced while its goal is live by the goal's wording and `elapsed <age>` from the goal's creation (`review 1/1 · elapsed 40m`); a waiting item whose newest run ended reads none, its `<wait>` (`2h`, the age since that run ended) on the second line instead; multiple runs read `N runs · <newest run's time>`.
- An item reads `open <age>` from its first `<open>` (`opened_at`), kept across stage updates, and a rename (the earlier of the two), started again by a reopen; it leads the metadata line in text and IM, and rides the second line on the web, the sidebar's included. A row written before the record takes its earliest run's queue time, else reads none.
- Goal wording names review/fix progress, clean review, findings at the cap, decisions, failure and legacy merge; nonempty decision/failure reasons wrap, initial work adds no redundant review label, and worker metadata names only running, failed and interrupted workers.
- `openItemsStatus` returns compact `text`, a `seed` and a version-1 presentation `snapshot`, all from one read; no items yields `Nothing open.`.
- The seed is one line per item, the full problem kept as the `<done>` key: `- <problem> — <stage> (run <id> · session <id>, run …) · <status>`; an empty stage drops ` — <stage>`, a run with no session drops `· session`; the owed misses follow, `Nothing open.` standing for no item.
- The chain's runs in no item follow apart, after a blank line, never in a key's place: `Runs in no item — not keys, never <done> one; <open> an item naming a run that is tracked work:`, then `- run <id> · session <id> · <name> · <running|queued>` each; `/status` and the snapshot draw them as rows.
- Compact text and command cards group waiting rows under `Waiting on you`, running/queued under `In progress`, and wrapping up/stopped under `Other open`, with counts and no empty groups; IM separates title/status, stage and metadata by lines, with no non-clickable run IDs.
- `/status`, trimmed and case-insensitive with nothing else on the message, is
  taken by `MainChain.send` before dispatch: the head (rotated when due) gets the
  text (`ChainDeps.status`, `openItemsStatus`) as a `chat-command` system input, mode `append`, no turn, kept out of the model's context (`agent/pi.ts`), its origin
  carrying `sessions`, run id → session id, and optional `statusSnapshot` with fixed display text and targets; replay validates the snapshot, ignoring keys it does not read, and logs a malformed one, retaining original text and a visible fallback notice. Old commands keep their text and uniquely resolvable run links; any
  other text, `/tmp is full` included, is a message.
- Surfaces: the `/status` card, and the web's status panel, opened by the bar's
  lead item — the same statuses as rows, `waiting on you` first in one list (`GET /api/continuous/open`),
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn, shown at once even while the head replies and
recorded after that turn; only `/chain` (§Chains), `/new` and `/done` (§Open items) take words after it); an unknown `/word` is a message, never an
error: the composer is not a shell.

The commands, their spelling (`/` or `%`) and what each answers on the head
and in a thread are [11 §Chat commands](11-im-conversation.md#chat-commands).
`/new` rotates with reason `new` (the seed without the previous session's
line, so it is the user's way to change the subject; the divider names it); a head
the send already rotated for its own reason is not rotated twice; a streaming
head is aborted first, never waited for; the answer is the new head's seed
card. `/new <text>` is the same rotation with `text` dispatched to the new
head as its first message — a message, not a command: it carries a receipt
and orders the chain list (`commandStartsTurn`, `core/types.ts`).

- The word list is `CHAT_COMMANDS` in `core/types.ts` — word → the one line the
  composer's completion shows; `chatCommand` (`core/types.ts`), the transcript
  rebuild (`agent/events.ts`) and the completion
  ([03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts)) all read it.
- Tests: `core/chain.test.ts` (`/new`, `/new <text>`, `/stop`, `/done`), `web/server.test.ts` (the
  route, the 409), `web/ui/composer.test.ts` (the completion), `tasks/open-items.test.ts`
  (`closeItem`).

## Run ledger

- `TaskService.ledger` over `TaskStore.ledgerRuns`: runs launched by the given
  sessions, in flight or finished since a time, at most 200; the seed reads it
  since the previous head's start and drops the succeeded and skipped runs, `pier task runs` over the last 24h
  ([09 §`runs`](09-tasks-cli.md#runs)).
- Callbacks and ownership follow the chain: a result owed to
  any member goes to the head (`MainChain.chainOf` in `TaskService`), and every
  member counts as a run's launcher (`tasks/operations.ts`).

## Storage

The tables are `chains`, `main_chain` and `open_items` in `db.ts`.

- `chains(id, name, created_at, archived_at)`; `main_chain.chain_id` and
  `open_items(chain_id, problem)` key rows to their chain, so a problem is
  unique within its chain only.
- A chain's head is its newest `main_chain` row; the transcripts are the record.
- `open_items` is Pier's store of the open items, never MEMORY.md.
- Surfaces reach the conversation through `MainChain`, which dispatches to the
  head's own `web:<id>` key, or the home chat's key
  ([11](11-im-conversation.md)); the router knows nothing of the chain.

## Web

The routes (`/api/continuous*`), the status panel, the pane and its
composer are [03](03-web-workbench.md)'s. An earlier member is read off disk,
never opened.

- The status panel's sessions are the live ones less the sessions making up the head;
  needs you = unread: a finished lead stays while unread and leaves once viewed.
- The head's ⋯ menu is Session info, Browse files, Model & reasoning,
  Settings; search is `pier search`, not a web surface.

## Not built

- Out of this design: workers nested under their lead in In progress (the
  text's `workers` counts are that), a stage derived from git, a done list.

## Acceptance

- A week of daily use, web and one IM DM, with no manually opened session and
  every rotation, dispatch, callback and failure visible where it came from.
- A follow-up reaches the same child verbatim; the head edits nothing outside
  the home; one feature runs through a lead with the head seeing milestones only.
- The week's largest head is recorded; above ~300K tokens, intra-session
  paging is next.
- From the head's transcript usage: it averages ≤ 2 model calls per user
  message; uncached input stays under 2% of input; no head compacts; `full`
  rotations lose nothing the user has to repeat.
- A head started by `/new` or after an hour answers a question on a new
  subject with no trace of the previous one: its seed is `MEMORY.md`, the open
  items, the newest 2K of notes and the ledger, under ~5K tokens; `MEMORY.md`
  is still under 4K chars after a week; a return after a week's silence still
  sees the last notes, and a question about anything older is answered after
  one `rg`/`pier search`, not from the seed.
- After a day of use, `/status` names every problem in flight or waiting on
  the user, in their words, with a stage matching the transcript and no
  backlog; a stale stage is fixed in `DISPATCHER`, never in the view.
