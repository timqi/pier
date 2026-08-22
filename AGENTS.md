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
4. **Core is platform-blind and Pi-blind.** Only `agent/` imports the Pi SDK;
   only `channels/` imports platform SDKs.
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

- `core/` routing, steer/follow-up policy, scheduler, event fan-out
- `channels/` one file per platform: normalize inbound, render outbound
- `agent/` Pi SDK behind `AgentSession`
- `web/` chat + observability timeline, an event-stream consumer
- `tasks/` cron + prompt + session config; one custom tool is the entire
  agent-collaboration surface
- Dependency direction: `channels/ | web/ | tasks/ → core/ → agent/`. Never sideways.

## Budgets (tripwires — exceeding needs a written diagnosis in the PR)

Measured in non-blank, non-comment lines, excluding tests. A budget only earns
its place by being able to fail *meaningfully*: one that is always over is a
comment, not a tripwire. Revised after the Slack adapter — see
`docs/design/06-design-review.md` for the numbers behind each.

- **`core/` ≤ 500 total** — the constraint that has actually shaped the design.
  Core is platform-blind and Pi-blind; if it is growing, something leaked in.
- **any one module ≤ 300** — still the right unit. A file over this is either
  two concerns or a wrong-layer abstraction.
- **channel adapter ≤ 400** per platform, across its four files' *adapter* file
  (transport, render and panel are budgeted as ordinary modules). Inbound
  normalization and gate logging are irreducibly per-platform; 200 was wishful.
- **`web/` ≤ 4.5k** — the largest area and the least tested, so it gets the
  budget that is closest to biting. Growth here should come with a reason why a
  surface, not a shared primitive, is the right home.
- **`tasks/` ≤ 2.5k**, **`channels/` ≤ 3.5k** — near their current size on
  purpose: the next feature in either should be visibly worth it.

No repo-wide number. It fired unconditionally and therefore said nothing; the
per-area budgets above are what a diagnosis can be written against.

## Bug Prevention

- Strict TypeScript; no `any` at seams. Changing a seam is a design decision.
- Test the seams: adapter golden tests (mocked clients), core queue/schedule
  units. Hermetic — no real `$HOME`, creds, or network.
- Validate at boundaries, trust internally; malformed input is logged and
  dropped, never half-handled. No silent `catch`.
- Deps: official platform SDKs or nothing; SQLite direct, no ORM; no
  frameworks in core.
