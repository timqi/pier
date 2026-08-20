# Pier Bootstrap Plan

Roadmap for the initial build. Read `AGENTS.md` first — principles and
budgets there override anything here. System contract: `src/core/types.ts` +
`docs/architecture.md`. Design docs exist only for in-flight/pending work
(completed specs are deleted once code + tests carry the knowledge); write
`docs/design/0N-*.md` for a step before dispatching it to an implementer.

## Context

- Standalone TypeScript/Node program embedding the Pi SDK
  (`@earendil-works/pi-coding-agent`), not a Pi extension.
- Pi SDK chosen over RPC: `steer()` / `followUp()` and event subscription are
  first-class in-process; keep `AgentSession` as a seam so RPC (process
  isolation) can replace it later without touching callers.
- Web workbench comes before IM channels: it is the fastest feedback loop for
  the core features (steering, queued messages, live observability) and needs
  no bot tokens.

## Steps

1. **Skeleton** — done.
2. **Agent seam** — done (`src/agent/`, seam per `src/core/types.ts`).
3. **Web workbench** — done and grown well past v1: chat + activity groups,
   steering/queue semantics with recall, model picker, derived projects,
   markdown, image attachments. Living spec: `docs/design/03-web-workbench.md`.
4. **Tasks + Subagents** — durable `Trigger + Action` definitions and immutable
   runs; manual/cron/watch triggers; Agent/Bash/Task actions. Agent Tasks support
   reused, fresh, and forked persisted Sessions, bounded fan-out, control,
   continuation, and supervisor messages through Console + HTTP + one Pi tool.
   Design: `docs/design/04-tasks.md`.
5. **First IM channel: Telegram** — thinnest adapter, validates the
   `Channel` seam. Inbound normalize, outbound markdown render. Default
   queue policy: busy agent → `followUp()`; `!` prefix → `steer()`.
6. **Show pages** — static HTML output dir + file server + optional SSE
   auto-reload. No runtime, no client framework. Pi's `export_html` gives
   session replay for free.
7. **Slack, Lark channels** — repeat step 5's pattern, ≤ 200 lines each.

## Status

- [x] 1. Skeleton
- [x] 2. Agent seam
- [x] 3. Web workbench (verified in daily use)
- [x] 4. Tasks (`docs/design/04-tasks.md`)
- [ ] 5. Telegram channel (design doc pending)
- [ ] 6. Show pages (design doc pending)
- [ ] 7. Slack + Lark (design doc pending)
