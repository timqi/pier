# Pier — Principles

Pier is a minimal agent workspace on the Pi SDK: IM channels (Slack, Lark)
and a Web UI in front of Pi sessions, with steering/queued messages,
scheduled tasks and live observability.

## Principles

1. **Less code is the feature.** Every line is a liability. If Pi already does
   it (sessions, steering, follow-up queues, compaction, HTML export), we don't.
2. **Bloat is a bug.** Growth that no feature needs is diagnosed, not written:
   the cause is usually a wrong-layer abstraction or a feature that shouldn't exist.
3. **Two seams only.** `Channel` (platform ↔ core) and `AgentSession`
   (core ↔ Pi). Only `agent/` imports the Pi SDK; only
   `channels/` imports platform SDKs; `core/` is blind to both, so Pi stays
   swappable (SDK → RPC later) and platform quirks stay out of core.
4. **One event stream per session.** Web UI and logs are both
   consumers of it — never parallel bookkeeping.
5. **Nothing that happened may look like nothing happening.** Every turn is
   observable on the surface it came from: an empty reply posts its footer and
   names which kind of nothing it was (`stayed silent — <reason>` / `no reply`);
   every failure reaches the conversation, not only the web timeline. A silent
   `catch` is a bug even when the fallback works.
6. **No speculative generality.** The third repeat earns an abstraction.
7. **Fast by default.** Optimistic rendering, no blocking fetches on the
   interaction path, no heavy client runtime. If an action needs a round trip,
   render first and reconcile from the event stream.
8. **Minimal dependencies — supply chain is attack surface.** Stdlib first,
   then official platform SDKs, Pi, and well-audited staples that also delete
   our own code. No micro-deps, no transitively-heavy packages; a new runtime
   dep carries a one-line justification in its commit. Lockfile pinned, diffs
   reviewed on upgrade.

## Architecture

- `core/` routing, steer/follow-up policy, event fan-out
- `channels/` one file per platform: normalize inbound, render outbound
- `agent/` Pi SDK behind `AgentSession`
- `websearch/` `pier web search|fetch` over the CLI socket: the provider's
  hosted search and fetch on the wire with the instance's model auth, no SDK import
- `web/` chat + observability timeline, an event-stream consumer
- `tasks/` scheduler; cron + prompt + session config; `pier task` over the CLI
  socket is the entire agent-collaboration surface
- Root `src/*.ts` is the instance layer — entry points (`main.ts`, `cli.ts`),
  ops (`service.ts`, `update.ts`, `stop.ts`) and the leaves any area may import
  (`paths.ts`, `db.ts`, `log.ts`, `secrets.ts`, `settings.ts`, `vault.ts`); one
  reason per file, named in docs/architecture.md
- **One writer per instance directory.** Pier's own process is the only writer
  of its Pi session directory — no external `pi` CLI, no second Pier on the
  same `~/.pier`, enforced by a pid claim on `$PIER_HOME` taken before the
  database opens — so in-process knowledge of what changed may be trusted.
- Dependency direction: `channels/ | web/ | tasks/ | websearch/ → core/ → agent/`.
  Runtime dependencies never go sideways. The browser may import owner-defined
  HTTP DTOs from `tasks/types.ts` and `channels/types.ts` type-only.
- `agent/types.ts` imports no SDK and no `node:*`; any area may import it.
- **Browser-safe core.** `web/ui/` bundles `core/types.ts`, `core/reply.ts`,
  `core/identity.ts` and `core/inbound-file.ts`, so those four import no
  `node:*`, directly or transitively; `core/` modules that need Node
  (`router.ts`, `inbox.ts`, `chain.ts`) are never imported from `web/ui/`.

## UI/UX

Before changing browser presentation or interaction, read
[UI/UX design guidelines](docs/design/06-ui-ux.md) — the contract for
materials, hierarchy, editing, motion and accessibility — and
[Web Workbench](docs/design/03-web-workbench.md), which owns the web behavior
and wire contract. Keep both current when behavior changes.

- Reuse the existing controls, palette and event state; no per-page versions
  of the same component, no parallel bookkeeping for presentation.
- Interaction correctness is design: verify overlay hit targets,
  keyboard/touch access, cancellation and replay, not just screenshots.
- One change covers both widths: a UI change is finished when the phone is
  finished too, with the same materials and vocabulary. Where the phone needs
  its own answer (touch targets, the drawer, safe-area insets), the doc says so.
- Report actual browser coverage; Chromium emulation is not Safari/iOS.

## Docs

A document holds contracts, facts and commands. The reasoning is the commit
that made them; the history is `git log`.

- One reason per file, named in its first line: `deploy.md` the operator's
  runbook, `architecture.md` the map and the seams, `design/*` one area's
  behaviour and wire contract, `skills/*` instructions an agent reads at
  runtime. A paragraph that does not serve that reason is deleted, not moved.
- A rule is one sentence, a fact one bullet, a command a code block. No "what
  it replaced", no incident numbers, no justification longer than a clause.
- Nothing the code already says: a unit file the installer renders, a type
  the seam declares, a directory tree `ls` gives. Point at the file.
- A doc that grows owes the same sentence as code (Budgets rule 1).

## Budgets

The target is disordered growth and duplication. Line counts are only a
reference: never compress lines or trade readability to stay under a ceiling.

**1. Growth is a claim, and a claim gets a sentence.** A change that adds net
lines to an area names, in the commit, what the feature could not have been
without those lines. Nothing to say → the lines should not be there.

**2. Splitting a file is not a reduction.** A module is split when it has two
reasons to exist, never to move a number. The header names the single reason;
a header that needs "and" is the tripwire.

**3. The third copy is a bug.** The same logic in three places is fixed or
deleted; a copy-paste pair longer than ~30 lines is reported at two. Count on
all surfaces, the Console included.

**4. Never traded for a number.** Tests; the failure paths principle 5
requires; type and seam declarations; code written plainly.

**5. Crossing a ceiling raises it.** `just size` prints the current numbers.
A change that crosses a ceiling checks rules 1–3, then raises the ceiling in
the same change.

| Area | Ceiling |
| --- | --- |
| `core/` | 2k |
| `channels/` | 5k |
| `web/` | 13.6k |
| `agent/` | 3.2k |
| `tasks/` | 4.2k |
| root `src/*.ts` | 3.8k |
| `websearch/` | 1.2k |
| `native/` | 1.3k |
| one module | 800; `web/ui/chat.ts` 900 |
| channel adapter file | 500 |

Non-blank, non-comment lines, tests excluded. No repo-wide number.

## Comments

A comment states the *why* the code cannot — a constraint, an invariant, a
non-obvious consequence — in one or two lines. Nothing else:

- No history: what it used to be, what the bug looked like. That is `git log`.
- No narration of *what* the code does; the code says that.
- No essays. A block past ~4 lines is a design note that belongs in `docs/`;
  a file header is one paragraph naming the module's single reason to exist.
- Doc comments on exported seams (`core/types.ts`, `agent/types.ts`,
  `channels/types.ts`, `tasks/types.ts`) keep their contract wording; that is
  declaration, not prose.

## Bug Prevention

- Green before every commit: `npm run check && npm run lint && npm test`.
- rtk runs `npm run lint` as `rtk lint` (ESLint) unless rtk's `[hooks] exclude_commands` lists it, which `pier tools sync` does (`src/tools.ts`); ESLint output from `npm run lint` means that exclusion is missing.
- `wt merge` removes the worktree it runs in and Pi refuses every later command in a session whose cwd is gone, so a merge runs from the main checkout (`wt -C <worktree> merge --no-squash main`), never from the worktree's own session.
- Strict TypeScript; no `any` at seams. Changing a seam is a design decision.
- Test the seams: adapter golden tests (mocked clients), core queue/schedule
  units. Hermetic — no real `$HOME`, creds, or network.
- Validate at boundaries, trust internally; malformed input is logged and
  dropped, never half-handled. No silent `catch`.
- SQLite direct, no ORM; no frameworks in core.
- **Never kill by pattern.** No `pkill`/`killall`/`kill` by name or `-f` — this
  repo's own process is `node dist/main.js`, so the match hits production. Kill
  only a PID you started (`node dist/main.js & pid=$!; trap 'kill $pid' EXIT`).
  The live service is `systemctl --user … pier`; stopping or restarting it is
  destructive — ask first.
