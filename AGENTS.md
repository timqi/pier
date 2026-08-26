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
   indistinguishable from a crash, a dropped connection or a bug, and the person
   waiting has no way to tell them apart — so "send nothing" is never the
   answer, and a silent `catch` is a bug even when the fallback works. This cost
   two rounds of debugging to learn: the surface being debugged from was not the
   surface showing the problem.
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
both, and a proxy optimized against stops measuring: the first version of this
section was an absolute ceiling per area, and what it actually produced was one
file split into three with the same total, and pressure to leave a failure
silent because reporting it cost lines. So the rules below are written to fail
on the thing, not on the number.

**1. Growth is a claim, and a claim gets a sentence.** A change that adds net
lines to an area names what it bought. "A feature was requested" is not the
answer; what the feature could not have been without those lines is. Nothing to
say → the lines should not be there.

**2. Splitting a file is not a reduction.** Moving 300 lines into a new module
changes one number and no facts. It is worth doing when a module has two
reasons to exist — and *that*, not a line count, is the test. Name the single
reason each module exists in its header comment; a header that needs "and" is
the tripwire.

**3. The third copy is a bug.** Duplication is what the budget was always
reaching for, so it gets a rule of its own: the same logic in three places is
fixed or deleted, not counted — and a copy-paste pair longer than ~30 lines is
reported even at two. Count the copies on *all* surfaces: the Slack and
Telegram panels drifted for months while the same vocabulary sat in the Console
as a third copy nobody was counting.

**4. Three things are never traded for a number.** Tests; the failure paths
principle 5b requires; type and seam declarations. If an area is over because
of these, it is not over.

**5. Sizes worth a second look, not a gate.** Non-blank, non-comment lines,
excluding tests. Crossing one is a prompt to ask "what is in there?", and the
answer is allowed to be "the right things":

| Area | Now | Second look past |
| --- | --- | --- |
| `core/` | ~895 | 780 — second look done: platform- and Pi-blind. Growth bought the shared presentation vocabulary, sender prefix, inbound-file convention, provider seam/validation, routing failure paths and the restart gate; none is a platform implementation |
| `channels/` | ~4.13k | 4.3k — second look done: the growth is the Lark adapter (five files, the same shape Slack settled on — adapter, api, render, outbound, panel); the shared layer grew only by a moved fence-balancer and the extracted event dedup, both second-copy fixes; from 3.96k the outbound attachment — a file the agent produced reaching the chat as a file instead of a `file://` link nobody else's machine can open, which takes one upload call per platform and the shared `attach.ts` that keeps the grammar, the caps and the lost-attachment line from becoming three copies |
| `web/` | ~8.5k | 8.6k — largest and least tested. Growth from 5.1k bought the password boundary, secure provider configuration and the Settings console; from 6.46k the Files view — project tree, whole-file inline diffs, the diff picker — rendered with zero new dependencies, which is exactly where the lines went; from 7.34k the Terminal — a real shell per project cwd that outlives the page, mirrored across pages, behind the same password boundary — which could not exist without a pty, a WebSocket upgrade path and an emulator view; from 7.8k Web Push — a finished turn reaching a workbench nobody has open, on desktop Chrome and on an iPhone's Home Screen — which needs the RFC 8291/8292 wire format (a dependency-free ~120 lines, against the RFC's own test vector), the subscriptions to send it to, a service worker, and the one rule that decides a notification; from 8.3k the extension switches — a section in the tab that already lists extensions, and a settings route that answers with the catalog beside the setting so a switch cannot draw a state nobody stored; the topic strip lost a tab in the same change (Providers and the model menu are one topic, not two); from 8.37k the provider probe — a model the operator picks (nothing picks one for them), and the line under the row carrying both halves of the exchange verbatim, because a refusal only means something next to what provoked it; +6 net for the second reader of a file the Console did not write — the Files view's renderer became `ui/code.ts` instead of a second bare `<pre>` (rule 3, caught at the second copy); the next growth needs its own sentence |
| `tasks/` | ~2.56k | 2.5k — second look done: delivery proof/backoff/ceiling was consolidated into one outbox engine; the remaining growth is durable control-message state and required failure paths |
| root `src/*.ts` | ~1.4k | 1.3k — second look done: the instance layer now owns secure credentials, service/update operations and the graceful-restart ledger; each remains a one-reason module, and the growth since is one schema migration, the composition line that hands the push surface its dependencies, and the enabled-extension set — stored by shape only, because the catalog is code and naming it here would drag the Pi SDK into the instance layer |
| one bundled extension | — | 500 — the area has no number: extensions are pluggable, not core, so each one pays for itself or is not shipped. `web` is ~970 and carries its sentence: web access with no second service, no API key of its own and no new dependency, which takes two provider wire formats (Anthropic tool-use, OpenAI Responses), the language-preservation audit that is the reason it exists, and retry/timeout policy against someone else's endpoint — the last 80 lines are the failure paths rule 4 exempts: one ceiling for the whole call, a truncated answer saying so on both backends, and progress on a surface that was silent for a minute |
| one module | — | 300 — see rule 2 before splitting |
| channel adapter file | — | 400 — transport, render and panel budgeted separately |

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
