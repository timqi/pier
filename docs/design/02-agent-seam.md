# Design 02 — Agent Seam

Goal: `src/agent/pi.ts` implements `AgentFactory`/`AgentSession` (from
`src/core/types.ts`) on top of `@mariozechner/pi-coding-agent`. Budget ≤ 200
lines. This is the ONLY file allowed to import `@mariozechner/pi-*`.

## Mapping

| Pier seam            | Pi SDK                                              |
| -------------------- | --------------------------------------------------- |
| `create({cwd})`      | `createAgentSession({ sessionManager: SessionManager.create(cwd), ... })` |
| `resume(id)`         | `SessionManager.open(<session file for id>)`        |
| `list()`             | `SessionManager.listAll(...)`                       |
| `prompt/steer/followUp/abort` | same-named session methods                 |
| `subscribe`          | `session.subscribe(...)` + event translation        |
| `state`              | `session.isStreaming ? "streaming" : "idle"`        |
| `dispose`            | `session.dispose()`                                 |

## Event Translation (Pi → SessionEvent)

Translate in one pure function `toSessionEvent(piEvent): SessionEvent | null`
so it is unit-testable without Pi:

- `agent_start` → `state: streaming`; `agent_end` → `state: idle` and
  `turn-end` with the final assistant text
- `message_update` text_delta → `text-delta`; thinking_delta → `thinking-delta`
- `tool_execution_start` → `tool-start`; `tool_execution_end` → `tool-end`
- `queue_update` → `queued`
- anything else → `null` (dropped). Do NOT invent event types; extend
  architecture.md first if a new one is needed.

`seq`/`ts`/`sessionId` are stamped by `core/hub.ts`, not here — the seam emits
payloads, the hub owns ordering.

## Rules

- No Pi types in any exported signature. If you need a Pi type externally,
  the design is wrong — stop.
- Errors from Pi calls become `error` events plus a rejected promise for the
  originating call; never leak Pi exception classes.
- Model/provider selection: pi's own config/env for now (no Pier config).

## Tests

- Unit: `toSessionEvent` golden table — every mapped Pi event shape in,
  expected SessionEvent out, unmapped shapes → null.
- Integration (optional, skipped in CI without creds): create a session in a
  temp cwd, prompt a trivial turn, assert `turn-end` arrives. Hermetic: temp
  dir only, never real `$HOME`.
