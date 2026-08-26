# Desk (design)

> **Status: phases 1a, 1b and 1c are implemented.** What landed differs from
> the text below in four places, each marked *(landed: …)* where it occurs:
> the templates ship as `src/web/desk-AGENTS.md` / `src/web/desk-projects.md`
> beside the module that reads them (not `src/desk/`); `POST /api/desk`
> delegates to the one `openSession` function `POST /api/sessions` also calls,
> instead of repeating its sequence; the Desk group is capped at the newest 5
> with an "older in ⌘K" line; and open question 1's probe was run — the answer
> was "the transcript renders nothing", so the `context-compacted` event
> exists. Phase 2 is still unbuilt.

**Desk** is one continuous dispatcher conversation with its own folder. The
folder (`$PIER_HOME/desk/`) is the identity: its `AGENTS.md` is the dispatcher
prompt Pi injects natively, its `projects.md` is the user-maintained index of
where work lives, and its path is the bus project scope the dispatcher writes
its durable facts into. Desk is **not** a new session kind, a new scheduler, a
new store, or a change to how projects and sessions work — it is an ordinary Pi
session in an ordinary directory, which routes work by delegating to subagents
with the `task` tool and relays their reports back. Everything that makes it a
dispatcher is prose in a file the user can read and edit; everything that makes
it visible is derivation from a cwd, the same way Projects and Boards are
derived. Delete the folder and Desk is gone with no orphaned row anywhere.

## Product decisions

1. **The folder is the identity, and the filesystem is the truth.**
   `$PIER_HOME/desk/` with two files: `AGENTS.md` (the dispatcher prompt) and
   `projects.md` (the index). No `deskEnabled` setting, no `desk_sessions`
   table, no stored boolean saying it was seeded — mirroring the librarian,
   which is "not auto-seeded; create it once" (docs/bus.md, *The librarian*)
   and boards, which are "derived by scanning, never registered"
   (docs/design/05-boards.md, decision 1).
2. **Zero new prompt mechanism.** Pi discovers `AGENTS.md` from the session's
   cwd itself (`src/agent/pi.ts:521`, `agentsFilesOverride` only *appends*
   Pier's surface prompt, so the user's file still wins). A dispatcher prompt
   is therefore a file write, not code.
3. **A reset is cheap, because the transcript is not the state.** State lives
   in `AGENTS.md` (how to work), `projects.md` (where things are) and bus facts
   (what was decided). The prompt mandates writing a durable fact at state
   transitions — decisions, blockers, conclusions — under one test: *would a
   fresh session be lost without this line?* Not every turn.
4. **The dispatcher never guesses a cwd.** Every delegation carries an explicit
   absolute `cwd` copied from `projects.md`. A project not in the index is not
   routable; the dispatcher asks the user to add it.
5. **Workers carry the summarization burden.** Every delegation prompt demands
   a self-contained final report (conclusion first, then links/paths). The
   dispatcher's job is faithful relay with a deep link, not re-analysis — its
   context stays small, which is what makes a flagship model cheap here.
6. **Nothing about projects or sessions changes.** Desk is layered on top of
   the existing substrate; the phased plan below touches no routing, no
   session lifecycle and no project derivation.

## Folder contract

```
$PIER_HOME/desk/
  AGENTS.md     the dispatcher prompt — Pi injects it because it is the cwd's AGENTS.md
  projects.md   the index: name, canonical absolute path, one line of what it is,
                standing instructions
```

- Both files are **user-owned**. Pier writes them once, when they are absent
  (see *Seeding*), and never again.
- Anything else the user puts in the folder (notes, scratch files) is theirs;
  Pier does not scan or interpret the folder's contents.
- **The path is canonical or the bus splits.** `main.ts:102-113` resolves a
  session's cwd through `realpath` before it becomes a bus scope, because two
  spellings of one directory are two disjoint blackboards. So: `DESK_DIR` is
  derived from `PIER_HOME` (`src/paths.ts`), and the sidebar's detection rule
  must compare against the **realpath** of it — if `$PIER_HOME` sits under a
  symlink, `pierPath("desk")` and the cwd Pi reports will differ in spelling.
  The same trap reaches `projects.md`: an entry naming an aliased path routes
  a worker into a different project scope than the canonical spelling, so the
  template tells the user to write `realpath` output.

## What exists already, and what must be built

Grounded, because two of the assumptions in the brief do not hold.

| Assumption | Reality |
| --- | --- |
| Pi injects the folder's `AGENTS.md` | **Exists.** `src/agent/pi.ts:521-545` |
| The sidebar can show a pinned conversation above Projects | **Partly.** The rail renders *only* pinned sessions grouped by cwd (`src/web/ui/sidebar.ts:132`, `:346`); there is no "pin above Projects" concept. Desk becomes one special-cased group rendered before `pinnedProjects()` |
| A session's cwd is available to the browser | **Exists.** `SessionInfo.cwd` on every row (`src/web/ui/sidebar.ts:16`), served by `/api/projects` and `/api/sessions` (`src/web/server.ts:182`, `:220`) |
| The web chat has a **new-session** affordance | **Partly.** `#new-session` prefills the current session's cwd (`src/web/ui/sidebar.ts:550-560`) and a project row's ⋯ has "New session here" (`:294`). Neither is in the conversation's own header — `sessionMenu` offers info / pin / model / browse files only (`src/web/ui/session-header.ts:256-288`) |
| The web chat has a **compact** affordance | **Does not exist anywhere.** No `compact` on the `AgentSession` seam (`src/core/types.ts:220-256`), no route, no UI, and no compaction event translated at the seam (`src/agent/events.ts` has none). Pi has it: `AgentSession.compact(customInstructions?)` — `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:489` |
| Creating a session pins it | **Exists.** `src/web/server.ts:237-249` creates, attaches, pins and announces `sessions-changed` |
| A session is deep-linkable | **Exists.** `#/session/<id>` (`src/web/ui/views.ts:165`, `:193`); combined with the public URL the agent is told in its system prompt (`src/core/reply.ts:56-66`). **A run is not** — `#/activity/<arg>` args are tab names (`src/web/ui/activity.ts:358-361`), so a relay links the worker's `targetSessionId`, not its run |
| The dispatcher learns the child session id | **Exists.** `RunSummary.targetSessionId` (`src/tasks/tool.ts:24`, `:70`) |
| IM DMs can default to the desk folder | **Not as stated.** A chat's `cwd` defaults to `""` → `process.cwd()` (`src/channels/types.ts:105`, `src/channels/control.ts:120`, `src/channels/conversations.ts:89`), and a newly discovered chat *copies the platform seed once* (`src/channels/config.ts:94-116`). Making DMs land in the desk folder is either a hint on the existing cwd field (phase 1) or a change to `discoverChat` for `kind === "dm"` (phase 2, open question 3) |
| The dispatcher cannot read another project's bus scope | **Confirmed, with one exception worth using.** Reads see "the run trees the caller stands in … *plus* the active ones it delegated", its own project and `instance` (docs/bus.md, *Scope*). So a worker's `scope: "run"` facts **are** readable by the dispatcher while the tree is alive, and become unreachable when it ends (`src/bus/sweep.ts`). Durable cross-project state is therefore `instance`, or a fact the dispatcher itself writes into `project:<desk dir>` |
| The bus is available | **Off by default** (`busEnabled`, `src/settings.ts:43-48`); off, the tool is not offered at all. The prompt must degrade instead of failing, the way the librarian prompt does |

## The sidebar pin, without a second bookkeeping store

**Detection rule.** The Desk conversation is *a pinned session whose cwd is the
desk directory*. Nothing is stored about it — it is the same derivation that
already produces Projects.

- `deskDir` reaches the browser as a derived field on `GET /api/settings`, next
  to `extensionCatalog`, which already rides along for exactly this reason
  ("one round trip for the whole page", `src/web/instance.ts:107-112`). It is
  **not** a stored setting — `settings.get()` is spread, and the field is
  computed from `paths.ts`.
- `src/web/ui/sidebar.ts` splits the pinned list once: rows whose `cwd` equals
  `deskDir` render as the **Desk** section above Projects; `pinnedProjects()`
  drops them so Desk never also appears as a project. The split is a pure
  exported function (`splitDesk(list, deskDir)`) beside `groupByCwd`, so it is
  unit-testable without a DOM.
- **More than one desk session is normal** (each reset makes one), so the Desk
  section is a *group*, newest first, exactly like a project group — the
  current conversation is the newest row, the older ones stay visible and
  clickable rather than becoming state only ⌘K can find. That is the whole
  reason it is a group and not a single row: a hidden predecessor would be
  state nobody can see (AGENTS.md 5b).
- **When no desk session exists**, the section is one row: "Desk — open". It is
  always present; that row is how Desk is discovered, and it is what makes a
  stored "seeded" flag unnecessary.

### Every code touch, by seam

| Touch | File | What |
| --- | --- | --- |
| the path | `src/paths.ts` | `export const DESK_DIR = pierPath("desk")` — one line, and `paths.ts` is the leaf that already answers "where does Pier keep this" |
| seeding + open | `src/web/desk.ts` (new) | idempotent seed (mkdir, write each template only if absent) and `POST /api/desk`: seed → open a session in the folder. *(landed: the create/attach/pin/announce sequence was **extracted** from `POST /api/sessions` into one `openSession(cwd)` closure in `server.ts` and handed to `registerDeskRoutes` — repeating it here would have been the second copy, budget rule 3. The desk route's own job is the seed and nothing else.)* |
| the browser learns the path | `src/web/instance.ts:110` | `deskDir` added to `instanceSettings()` (derived, not stored) |
| the rail | `src/web/ui/sidebar.ts` | `splitDesk()`, the Desk section, the "open" row; `pinnedProjects()` excludes the desk cwd. *(landed: `splitDesk` also applies the cap — newest `DESK_CAP` = 5 — and returns how many it hid, so the "older in ⌘K" line is a pure value and not a render-time decision, open question 4.)* |
| boot wiring | `src/web/ui/main.ts` | read `deskDir` from the settings fetch, hand it to `initSidebar` deps |
| the two controls | `src/web/ui/session-header.ts:256` | two rows in `sessionMenu`: **Compact context** and **New session here** — for *every* session, not a Desk-only copy (rule 3: the third copy is a bug, and this would be the second) |
| compact, server | `src/web/server.ts` | `POST /api/sessions/:id/compact` via the existing `guarded(...)` helper |
| compact, seam | `src/core/types.ts` (`AgentSession`) | `compact(): Promise<void>` — **a seam change, therefore a design decision**: it is Pi-agnostic (any backend that can shrink its own context can implement it) and RPC-compatible |
| compact, Pi | `src/agent/pi.ts` | forwards to Pi's `session.compact()` |
| IM default (hint only) | `src/web/ui/channels.ts` | the chat cwd field offers the desk dir as a suggestion; no channel-layer behavior changes in phase 1 |

**The compact button's honesty problem, named rather than skipped.** Nothing at
the seam translates Pi's `compaction_start` / `compaction_end`, and it is
unverified whether Pi's compaction entry shows up in `pi.messages` → so it is
unverified whether `toChatTurns` (`src/agent/events.ts:144`) renders anything
for it. A button whose effect is invisible until you reload is exactly the
"nothing that happened looks like nothing happening" failure. Phase 1 therefore
probes it first (test below), and if the transcript says nothing, the compact
route's response is not enough: one event must be emitted on the session's own
stream. Recommended shape if needed — a `{ type: "context-compacted"; before:
number; after: number }` payload member, because a `system-input` would be a
lie (compaction is not input entering the model's context).

## Seeding

- **Never at boot.** The process writes no desk folder for an instance nobody
  asked. This mirrors the librarian decision (docs/bus.md: "It is not
  auto-seeded") and keeps a fresh `$PIER_HOME` unchanged by an unused feature.
- **On the user's click.** `POST /api/desk` — from the "Desk — open" row —
  creates the directory (mode 0700, like `core/inbox.ts:36`) and writes each
  template file **only if it does not exist**.
- **The user edits it: Pier never touches it again.** Both files are absent
  from every later write path.
- **The user deletes `AGENTS.md`:** Desk still works — it becomes a plain
  session in a folder — and the next explicit open re-creates the missing file
  from the template. That is a visible consequence of a user action, not a
  background restoration.
- **The user deletes the folder:** the desk sessions remain (Pi keeps their
  transcripts; their cwd is gone) and still group under Desk. The next open
  re-seeds. No cleanup, no stored state to reconcile.
- **A "Reset template" row is not in phase 1.** Copying a fresh template over
  an edited file needs a diff to be safe, and nobody has asked for it yet.

## Dispatcher behavior (the prompt's shape, in one page)

Full text: `src/web/desk-AGENTS.md`. Its load-bearing rules:

1. **Intent → project.** Read `projects.md`, pick the entry, confirm the path
   exists (`ls -d`) before spending a delegation on it. Not in the index →
   ask; never guess.
2. **Delegate with an explicit cwd and a self-contained prompt.** The child
   shares nothing implicitly (skills/pier-tasks/SKILL.md, *Chains*), so the
   prompt carries the paths, the acceptance criteria and the required report
   shape: conclusion first, then evidence as `path:line` or links.
3. **Relay near-verbatim, with the link.** The worker's conclusion and its
   caveats reach the user in the worker's own words plus
   `<publicUrl>/#/session/<targetSessionId>`. Paraphrasing away a caveat is
   the one failure that makes a dispatcher worse than no dispatcher.
4. **Durable facts at state transitions only**, with explicit scopes:
   `project` (the desk folder's own scope: routing decisions, standing
   preferences) and `instance` (facts other projects must see). It cannot read
   another project's scope, so the workflow never assumes a worker's
   project-scoped write will be visible — the worker either reports it in its
   final report, writes it `instance`-wide, or writes it into its **run**
   scope, which the dispatcher can read *while the run tree is alive*.
5. **After a reset:** rehydrate from `AGENTS.md` + `projects.md` + `bus get` /
   `bus search`, say in one line what it recovered, and continue. No transcript
   archaeology.

**Model.** A balanced flagship at thinking low/medium — the two expensive
skills are writing a self-contained delegation prompt and relaying a report
faithfully, and the context stays small. Set per session (⋯ → Model) or pinned
in the Console's model menu with an intent note. The template names **no model
id**: "catalogs move under you" (skills/pier-tasks/SKILL.md).

## Phased plan, with the growth claim each area owes

Line counts are non-blank, non-comment, tests excluded — estimates to be
checked against `AGENTS.md` *Budgets* when the code lands.

**Phase 1a — the folder and the pin (~+140 web, +1 root).** *(landed: +165 web
for 1a and 1b together, +1 root, +2 core, +16 agent.)*
`DESK_DIR`, `web/desk.ts`, `deskDir` on `/api/settings`, the Desk section, the
"open" row.
*web claim:* "+~140 for a dispatcher conversation that survives its own reset —
a folder whose `AGENTS.md` Pi already injects, detected in the rail by cwd
instead of by a new table, so the feature adds no bookkeeping that can drift
from the sessions it describes."
*root claim:* "+1: `DESK_DIR` is where Pier keeps a thing, which is the one
reason `paths.ts` exists."

**Phase 1b — the two controls (~+25 web, +3 core seam, +8 agent).**
`Compact context` and `New session here` in `sessionMenu`, the compact route,
the seam method, the Pi forward, and whatever observability the probe proves is
missing.
*web claim:* "+~25 so a session can be compacted and restarted from the
conversation it belongs to instead of from the rail — one menu, every session,
no Desk-only copy."
*core claim:* seam declaration + failure path — exempt under budget rule 4, and
the method is one line of contract.

**Phase 1c — the templates (prose, not code).**
Shipped like `boards/pier.css` and `bus/librarian-prompt.md` (one `cp` in
`package.json`'s `build:assets`, since `files` publishes `dist` only). Prose in
a `.md`, not a TS template literal: a 100-line prompt inside a string is a diff
nobody can review and an escaping bug waiting to happen.
*(landed: `src/web/desk-AGENTS.md` and `src/web/desk-projects.md`, not
`src/desk/`. The librarian precedent is "read lazily from beside the module
that owns it", and that module is `src/web/desk.ts`; a new one-purpose
directory would also have had to be named in docs/architecture.md. The `desk-`
prefix is deliberate: a file literally called `AGENTS.md` inside `src/` is an
instruction to every agent working in this repository. Two content fixes went
in with the move: `bus get` takes one **exact** topic and no glob, so the
rehydration reads `desk/threads`, `desk/decisions` and `desk/preferences` by
name instead of `desk/*`, and the prompt now names those three topics as the
places facts go.)*

**Phase 2 (recorded, not designed here).** IM DM default cwd at
`discoverChat`; a Desk badge for owed bus deliveries; "Reset template"; and a
compaction that is still visible after a reload — which is a change to the
transcript rebuild (`toChatTurns`), not to Desk.

## Non-goals for phase 1

Recorded so they are refusals, not omissions:

- **No automatic session-reset heuristics.** Tokens × idle × no-open-threads is
  a later phase; phase 1's reset is a button a human presses.
- **No `<fact…>` reply-convention auto-publish block.** Durable facts are
  explicit `bus publish` calls the prompt asks for.
- **No change to project or session management.** No new session kind, no
  project registry, no change to pinning, routing or the queue policy.
- **No auto-recall injection.** After a reset the dispatcher rehydrates by
  *asking* (`bus get` / `search`); nothing is prepended to its context for it.

## Tests

- `web/desk.test.ts`, hermetic tmp `PIER_HOME`: seed creates both files;
  a second seed does not overwrite an edited `AGENTS.md`; a missing
  `projects.md` is restored while the edited `AGENTS.md` is left alone; the
  seeded dir is 0700.
- `sidebar` unit on `splitDesk(list, deskDir)`: desk rows leave Projects; a
  symlinked desk path still matches (realpath applied server-side); no desk
  rows → the "open" row.
- Compact: route 404s an unknown session, forwards once, and — the probe —
  a golden assertion on what `toChatTurns` produces for a compacted transcript.
  If the answer is "nothing", the event added in 1b gets its own golden row in
  `agent/events.test.ts`.
- No test asserts on the template *prose*; asserting a prompt's wording freezes
  the one thing that must stay editable.

## Acceptance

- A fresh instance shows one **Desk** row; clicking it creates the folder, both
  files and a session in it, and the conversation answers as a dispatcher on
  its first turn.
- Asked for work in a project listed in `projects.md`, the dispatcher delegates
  with that exact absolute path and its relay carries the worker's conclusion,
  its caveats and a link that opens the worker's session.
- Asked for work in an unlisted project, it asks for the entry instead of
  guessing a directory.
- Compact, then continue: the conversation keeps working and the surface says
  the context was compacted.
- New session from the Desk header: the new conversation, given only
  `AGENTS.md` + `projects.md` + the bus, states the open threads it recovered
  and picks up the last decision — without the previous transcript.
- Editing `projects.md` by hand changes routing on the next turn, with no
  restart and nothing to re-register.

## Open questions

All seven are answered; the answers are the operator's, and the code follows
them.

1. **Compaction observability. — Probed: the transcript renders nothing.** Pi
   replaces the summarized entries with one `role: "compactionSummary"` message
   (`session-manager.ts`, `sessionEntryToContextMessages`), a role
   `toChatTurns` does not know, so a compacted session reloads with no trace of
   the compaction at all. The golden test in `agent/events.test.ts` asserts
   exactly that, and is the reason the approved `{ type: "context-compacted";
   before: number; after: number }` payload member exists: it is translated
   from Pi's `compaction_end` and drawn as a system row in the chat. **Still
   open, recorded rather than fixed:** the line is live-only — a reload still
   shows nothing, because the transcript rebuild is unchanged. Automatic
   compaction is covered by the same event, which is the case with no route to
   report through.
2. **Is `compact()` the right seam method?** — **Yes, approved.** It is
   backend-neutral and RPC-compatible; it returns `void`, because Pi's
   `CompactionResult` reaches surfaces as the event above.
3. **IM DMs: hint or default?** — **Hint only.** The chat's cwd field in the
   channels panel names the desk folder under it; no channel-layer behavior
   changed, and an empty field still means Pier's own directory (the hint says
   so, because a placeholder would have read as a default that is not one).
4. **Should a reset unpin its predecessor?** — **No: cap the section.** Newest
   5, with an "older in ⌘K" line when it cuts; nothing is unpinned and nothing
   is hidden without saying so.
5. **Should `projects.md` be validated?** — **No.** The dispatcher's `ls -d` at
   routing time is the check, and it costs no code.
6. **One Desk per instance.** Multiple desks stay undesigned.
7. **Does Desk want a bus subscription?** — **No**, for the reason given: it
   would make the dispatcher start turns nobody asked for.
