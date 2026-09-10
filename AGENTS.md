# Pier — Principles

Pier is a minimal agent workspace on the Pi SDK: IM channels (Slack, Telegram,
Lark) and a Web UI in front of Pi sessions, with steering/queued messages,
scheduled tasks, live observability, and static Show pages.

## Principles

1. **Less code is the feature.** Every line is a liability. If Pi already does
   it (sessions, steering, follow-up queues, compaction, HTML export), we don't.
2. **Bloat is a bug.** Over budget → stop and diagnose before writing more.
   The cause is usually a wrong-layer abstraction or a feature that shouldn't exist.
3. **Two seams only.** `Channel` (platform ↔ core) and `AgentSession`
   (core ↔ Pi). Only `agent/` and `extensions/` import the Pi SDK; only
   `channels/` imports platform SDKs; `core/` is blind to both, so Pi stays
   swappable (SDK → RPC later) and platform quirks stay out of core.
4. **One event stream per session.** Web UI, logs, Show pages are all
   consumers of it — never parallel bookkeeping.
5. **Nothing that happened may look like nothing happening.** Every turn is
   observable on the surface it came from: an empty reply posts its footer and
   names which kind of nothing it was (`stayed silent — <reason>` / `no reply`);
   every failure reaches the conversation, not only the web timeline. A silent
   `catch` is a bug even when the fallback works.
6. **No speculative generality.** The third repeat earns an abstraction.
   Show pages stay static HTML (+ SSE reload at most), no runtime.
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
- `extensions/` the extensions Pier ships with, loaded as Pi inline factories
  and switched on per instance from the Console — never copied to disk, and
  standing down when a copy on disk already registers the same tools; the
  Console shows them as the built-in `pier` package beside every package in
  Pi's own registry (settings.json `packages`), which Pier writes and never
  mirrors
- `web/` chat + observability timeline, an event-stream consumer
- `tasks/` scheduler; cron + prompt + session config; one custom tool is the
  entire agent-collaboration surface
- `boards/` static Show pages: a filesystem scan plus a file handler
- Root `src/*.ts` is the instance layer — entry points (`main.ts`, `cli.ts`),
  ops (`service.ts`, `update.ts`, `drain.ts`) and the leaves any area may import
  (`paths.ts`, `db.ts`, `log.ts`, `secrets.ts`, `settings.ts`); one reason per
  file, named in docs/architecture.md
- **One writer per instance directory.** Pier's own process is the only writer
  of its Pi session directory — no external `pi` CLI, no second Pier on the
  same `~/.pier`, enforced by a pid claim on `$PIER_HOME` taken before the
  database opens — so in-process knowledge of what changed may be trusted.
- Dependency direction: `channels/ | web/ | tasks/ | boards/ → core/ → agent/`.
  Runtime dependencies never go sideways. The browser may import owner-defined
  HTTP DTOs from `tasks/types.ts` and `channels/types.ts` type-only.
- **Browser-safe core.** `web/ui/` bundles `core/types.ts`, `core/reply.ts`,
  `core/identity.ts` and `core/inbound-file.ts`, so those four import no
  `node:*`, directly or transitively; `core/` modules that need Node
  (`router.ts`, `inbox.ts`) are never imported from `web/ui/`.

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

The target is disordered growth and duplication; line counts are a proxy, so
the rules fail on the thing, not on the number.

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
requires; type and seam declarations.

**5. Ceilings are a prompt, and a prompt has a deadline.** `just size` prints
the table below with current numbers; nothing is copied forward by hand.
Crossing a ceiling asks "what is in there?"; if the answer is "the right
things", the ceiling is raised with that sentence. A ceiling exceeded for more
than one release without a raise or a deletion is the failure this section
exists to catch.

| Area | Ceiling | What the size is |
| --- | --- | --- |
| `core/` | 1.5k | platform- and Pi-blind: presentation vocabulary, sender prefix, inbound-file convention, provider seam, routing failure paths, restart gate |
| `channels/` | 5k | four adapters in one five-file shape; the shared layer holds only what would otherwise be copied |
| `web/` | 13k | password boundary, chat, Settings console, Files, Web Push (RFC 8291/8292, no dependency), palette; the least tested area |
| `agent/` | 2.5k | the Pi side of the seam: open/resume, event translation, one-pass transcript listing and index, the package registry |
| `tasks/` | 3.2k | one delivery engine, durable control messages, a scheduler that isolates each due task, bounded watch history, owner seam |
| root `src/*.ts` | 3k | one reason per file: credentials, service/update ops, restart ledger, managed CLI tools via ubix |
| one bundled extension | 500 | pays for itself or is not shipped |
| one module | 750 | rule 2 before splitting; `agent/pi.ts` (sessions) and `agent/packages.ts` (the package registry) are the two files that may touch the Pi SDK, and every block in each does |
| channel adapter file | 400 | transport, render and panel counted separately |

Non-blank, non-comment lines, tests excluded. No repo-wide number.

## Comments

A comment states the *why* the code cannot — a constraint, an invariant, a
non-obvious consequence — in one or two lines. Nothing else:

- No history: what it used to be, what the bug looked like. That is `git log`.
- No narration of *what* the code does; the code says that.
- No essays. A block past ~4 lines is a design note that belongs in `docs/`;
  a file header is one paragraph naming the module's single reason to exist.
- Doc comments on exported seams (`core/types.ts`, `channels/types.ts`,
  `tasks/types.ts`) keep their contract wording; that is declaration, not prose.

## Bug Prevention

- Green before every commit: `npm run check && npm run lint && npm test`.
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
