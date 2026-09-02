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
   (core ↔ Pi). Nothing crosses a boundary outside its seam; Pi stays
   swappable (SDK → RPC later), platform quirks stay out of core.
4. **Core is platform-blind and Pi-blind.** Only `agent/` and `extensions/`
   import the Pi SDK — an extension takes an `ExtensionAPI`, so it is Pi-shaped
   by construction; only `agent/pi.ts` registers one and `core/` never sees the
   area. Only `channels/` imports platform SDKs.
5. **One event stream per session.** Web UI, logs, Show pages are all
   consumers of it — never parallel bookkeeping.
5b. **Nothing that happened may look like nothing happening.** Every turn is
   observable on the surface it came from, including the turns with no content:
   an empty reply still posts its footer and says which kind of nothing it was
   (`stayed silent — <reason>` / `no reply`), and every failure is delivered to
   the conversation, not only to the web timeline. Total silence is
   indistinguishable from a crash — so "send nothing" is never the answer, and a
   silent `catch` is a bug even when the fallback works.
6. **No speculative generality.** The third repeat earns an abstraction.
   Show pages stay static HTML (+ SSE reload at most), no runtime.
7. **Fast by default.** Web interactions must feel instant: optimistic
   rendering, no blocking fetches on the interaction path, no heavy client
   runtime. If an action needs a round trip, render first and reconcile from
   the event stream.
8. **Minimal dependencies — supply chain is attack surface.** Prefer stdlib,
   then officially-backed, actively-maintained libraries (platform vendors'
   SDKs, Pi, well-audited staples) that also reduce our own code. No
   micro-deps, no transitively-heavy packages; every new runtime dep needs a
   one-line justification in the PR. Pin versions via the lockfile and review
   diffs on upgrades.

## Architecture

- `core/` routing, steer/follow-up policy, event fan-out
- `channels/` one file per platform: normalize inbound, render outbound
- `agent/` Pi SDK behind `AgentSession`
- `extensions/` the extensions Pier ships with, loaded as Pi inline factories
  and switched on per instance from the Console — never copied to disk, and
  standing down when a copy on disk already registers the same tools
- `web/` chat + observability timeline, an event-stream consumer
- `tasks/` scheduler; cron + prompt + session config; one custom tool is the
  entire agent-collaboration surface
- `boards/` static Show pages: a filesystem scan plus a file handler
- Root `src/*.ts` is the instance layer — entry points (`main.ts`, `cli.ts`),
  ops (`service.ts`, `update.ts`, `drain.ts`) and the leaves any area may import
  (`paths.ts`, `db.ts`, `log.ts`, `secrets.ts`, `settings.ts`); one reason per
  file, named in docs/architecture.md
- Dependency direction: `channels/ | web/ | tasks/ | boards/ → core/ → agent/`.
  Runtime dependencies never go sideways. The browser may import owner-defined
  HTTP DTOs from `tasks/types.ts` and `channels/types.ts` type-only; those
  imports are erased at build and do not let web implement either area.

## Budgets

The target is disordered growth and duplication. Line counts are a *proxy* for
both, and a proxy optimized against stops measuring — an absolute ceiling per
area produced one file split into three with the same total, and pressure to
leave a failure silent because reporting it cost lines. So the rules below fail
on the thing, not on the number.

**1. Growth is a claim, and a claim gets a sentence.** A change that adds net
lines to an area names what it bought — not "a feature was requested", but what
the feature could not have been without those lines. The sentence goes in the
commit or PR; nothing to say → the lines should not be there.

**2. Splitting a file is not a reduction.** Moving 300 lines into a new module
changes one number and no facts. It is worth doing when a module has two
reasons to exist — and *that*, not a line count, is the test. Name the single
reason each module exists in its header comment; a header that needs "and" is
the tripwire.

**3. The third copy is a bug.** The same logic in three places is fixed or
deleted, not counted — and a copy-paste pair longer than ~30 lines is reported
even at two. Count the copies on *all* surfaces: the Slack and Telegram panels
drifted for months while the same vocabulary sat in the Console as a third copy
nobody was counting.

**4. Three things are never traded for a number.** Tests; the failure paths
principle 5b requires; type and seam declarations. If an area is over because
of these, it is not over.

**5. Sizes worth a second look, not a gate.** Non-blank, non-comment lines,
excluding tests — `find src/<area> -name '*.ts' -not -name '*.test.ts'`, and
re-measured when the column is cited, because a number copied forward is the
only way this table can lie. Crossing a threshold is a prompt to ask "what is
in there?", and the answer is allowed to be "the right things":

| Area | Now | Second look past | Second look done — what the size is |
| --- | --- | --- | --- |
| `core/` | ~1.0k | 780 | still platform- and Pi-blind: shared presentation vocabulary, sender prefix, inbound-file convention, provider seam, routing failure paths, restart gate — no platform implementation. The last +107 over the previous reading is what rule 4 exempts: the four ways a message could be lost between the state it was decided against and its arrival (router), the header read back off a stored message (`identity.ts`), and the seam and catalog declarations the Console draws a switch from |
| `channels/` | ~4.22k | 4.3k | four adapters in the same five-file shape (adapter, api, render, outbound, panel); the shared layer holds only what would otherwise be copied — fence balancer, event dedup, `attach.ts` |
| `web/` | ~11.4k | 8.6k — **second look due** | largest and least tested. Password boundary, Settings console, Files view, Terminal (pty + WS + emulator), Web Push (RFC 8291/8292, dependency-free), extension and managed-tool switches — each a surface, none a dependency. But the number in this column had drifted ~2.3k behind the code, which is the one failure this table cannot absorb: a proxy nobody re-measures is not measuring. The features above have their sentences; the last reading does not, and the next change here owes a real second look before it adds anything. The +0.5k of the perf pass is accounted for per commit: incremental streaming render, precompressed assets, one SSE frame per event with a write ceiling, lazy view chunks, streamed file reads with 304 — each a cost that was paid per tick or per client and is now paid once |
| `tasks/` | ~2.62k | 2.5k | one outbox engine for delivery proof/backoff/ceiling, durable control-message state, required failure paths, and the owner seam that protects Pier-created definitions |
| root `src/*.ts` | ~2.51k | 1.3k | one-reason modules each: secure credentials, service/update ops, restart ledger, and the managed CLI tools — ubix bootstrap, strict parse of its JSON, provision/removal order, one cross-process sync lock in `pier.db` |
| one bundled extension | — | 500 | no number: extensions are pluggable, so each pays for itself or is not shipped. `web` is ~980 — two provider wire formats, the language-preservation audit that is its reason to exist, retry/timeout policy |
| one module | — | 300 | see rule 2 before splitting |
| channel adapter file | — | 400 | transport, render and panel budgeted separately |

No repo-wide number: it fired unconditionally and therefore said nothing.

## Bug Prevention

- Strict TypeScript; no `any` at seams. Changing a seam is a design decision.
- Test the seams: adapter golden tests (mocked clients), core queue/schedule
  units. Hermetic — no real `$HOME`, creds, or network.
- Validate at boundaries, trust internally; malformed input is logged and
  dropped, never half-handled. No silent `catch`.
- Deps: official platform SDKs or nothing; SQLite direct, no ORM; no
  frameworks in core.
- **Never kill by pattern.** No `pkill`/`killall`/`kill` by name or `-f` — this
  repo's own process is `node dist/main.js`, so the match hits production. Kill
  only a PID you started (`node dist/main.js & pid=$!; trap 'kill $pid' EXIT`),
  or give the test process a unique marker; the live service is
  `systemctl --user … pier`, and stopping or restarting it is destructive — ask first.
