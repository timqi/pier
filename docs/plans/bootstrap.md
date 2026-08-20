# Pier Bootstrap Plan

Roadmap for the initial build. Read `AGENTS.md` first — principles and
budgets there override anything here. System contract: `docs/architecture.md`.
Per-step specs: `docs/design/01-skeleton.md`, `02-agent-seam.md`,
`03-web-workbench.md`.

## Context

- Standalone TypeScript/Node program embedding the Pi SDK
  (`@mariozechner/pi-coding-agent`), not a Pi extension.
- Pi SDK chosen over RPC: `steer()` / `followUp()` and event subscription are
  first-class in-process; keep `AgentSession` as a seam so RPC (process
  isolation) can replace it later without touching callers.
- Web workbench comes before IM channels: it is the fastest feedback loop for
  the core features (steering, queued messages, live observability) and needs
  no bot tokens.

## Steps

1. **Skeleton** — `git init`, package.json, strict tsconfig, directory layout
   (`core/ channels/ agent/ web/ tasks/`), define the two seam interfaces:
   `Channel` (platform ↔ core) and `AgentSession` (core ↔ Pi).
2. **Agent seam** — wrap Pi SDK in `agent/` behind `AgentSession`: create
   session, prompt/steer/followUp, subscribe to the event stream. Budget
   ≤ 200 lines.
3. **Web workbench (v1)** — chat + observability timeline + session list.
   SSE from the per-session event stream; verify steering and queued
   messages end to end here. This is the primary surface.
4. **First IM channel: Telegram** — thinnest adapter, validates the
   `Channel` seam. Inbound normalize, outbound markdown render. Default
   queue policy: busy agent → `followUp()`; `!` prefix → `steer()`.
5. **Scheduler** — `tasks/`: SQLite row = cron + prompt + session config.
   One custom Pi tool for agents to create/update tasks — that tool is the
   entire agent-collaboration surface.
6. **Show pages** — static HTML output dir + file server + optional SSE
   auto-reload. No runtime, no client framework. Pi's `export_html` gives
   session replay for free.
7. **Slack, Lark channels** — repeat step 4's pattern, ≤ 200 lines each.

## Status

- [ ] 1. Skeleton
- [ ] 2. Agent seam
- [ ] 3. Web workbench v1
- [ ] 4. Telegram channel
- [ ] 5. Scheduler
- [ ] 6. Show pages
- [ ] 7. Slack + Lark
