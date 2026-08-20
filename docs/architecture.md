# Pier Architecture

This document is the system contract. Module implementers must not deviate
from the interfaces and dependency rules here; changing them is a design
decision that happens in this file first, code second.

## System Shape

One Node process. Channels and the web workbench feed normalized messages
into core; core routes them to Pi sessions through the agent seam; every
session emits one ordered event stream that all surfaces consume.

```
Slack / Telegram / Lark          Web workbench (browser)
        │ Channel seam                  │ HTTP + SSE
        ▼                               ▼
┌─────────────────────── core ───────────────────────┐
│ router (conversation → session)                    │
│ queue policy (idle→prompt, busy→steer/followUp)    │
│ event hub (per-session buffer + fan-out)           │
│ scheduler (cron → prompt)            [step 5]      │
└──────────────────────┬─────────────────────────────┘
                       │ AgentSession seam
                       ▼
                agent/ (Pi SDK)
```

## Directory Layout

```
src/
  core/        types.ts, router.ts, hub.ts, queue.ts
  agent/       pi.ts (the ONLY file importing @mariozechner/pi-*)
  channels/    telegram.ts, slack.ts, lark.ts   [step 4+]
  web/         server.ts, static frontend       [step 3]
  tasks/       scheduler.ts, task tool          [step 5]
  main.ts      wiring only
```

Dependency direction: `channels | web | tasks → core → agent`. Core never
imports platform SDKs or Pi. Nothing imports sideways between channels.

## Core Types (src/core/types.ts — normative)

```ts
/** A conversation is the unit of session routing. */
export interface ConversationKey {
  channelId: string;        // "web" | "telegram" | "slack" | "lark"
  conversationId: string;   // platform thread/chat id, or web session ui id
}

export interface InboundMessage {
  key: ConversationKey;
  senderId: string;
  text: string;
  /** How to deliver when the agent is busy. "auto" = queue policy decides. */
  mode: "auto" | "steer" | "followUp";
}

/** Platform ↔ core seam. Implemented once per platform, ≤200 lines. */
export interface Channel {
  readonly id: string;
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  /** Render markdown to the platform's format and send it. */
  send(conversationId: string, markdown: string): Promise<void>;
  stop(): Promise<void>;
}

/** Pier's normalized event. The ONLY observability currency in the system. */
export type SessionEventPayload =
  | { type: "turn-start" }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-end"; toolCallId: string; isError: boolean; output: string }
  | { type: "turn-end"; text: string }        // full assistant text of the turn
  | { type: "state"; state: SessionState }
  | { type: "queued"; mode: "steer" | "followUp"; text: string }
  | { type: "error"; message: string };

/** Stamped by core/hub.ts — seq is per-session monotonic. */
export type SessionEvent = { seq: number; ts: number; sessionId: string } &
  SessionEventPayload;

export type SessionState = "idle" | "streaming";

/** Core ↔ Pi seam. Must stay implementable over RPC later. */
export interface AgentSession {
  readonly id: string;
  readonly state: SessionState;
  prompt(text: string): Promise<void>;   // resolves when the turn settles
  steer(text: string): Promise<void>;    // interrupt mid-run
  followUp(text: string): Promise<void>; // deliver when idle
  abort(): Promise<void>;
  /** Emits payloads only; core/hub.ts owns seq/ts stamping. */
  subscribe(fn: (e: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentFactory {
  create(opts: { cwd: string }): Promise<AgentSession>;
  resume(sessionId: string): Promise<AgentSession>;
  list(): Promise<{ id: string; cwd: string; createdAt: number; title?: string }[]>;
}
```

## Fixed Behavioral Rules

- **Queue policy** (`core/queue.ts`): `mode:"auto"` → if session idle,
  `prompt`; if streaming, `followUp`. Text starting with `!` → strip the
  prefix and `steer`. Explicit `mode` always wins. This is the whole policy;
  do not add options.
- **Event hub** (`core/hub.ts`): per-session monotonic `seq`, in-memory ring
  buffer (last 1000 events) for SSE replay via `Last-Event-ID`, synchronous
  fan-out to subscribers. No persistence — pi's session files are the durable
  record. `queued` events are emitted by the router when the queue policy
  defers a message (pi's `queue_update` is dropped at the seam).
- **Routing** (`core/router.ts`): `ConversationKey → sessionId` map, in-memory
  for v1 (moves to SQLite with the scheduler). Unknown conversation → create a
  session lazily via `AgentFactory`.
- **Outbound to IM channels**: on `turn-end`, core sends the turn's full text
  to the owning channel. IM surfaces get turn granularity; only the web
  workbench gets deltas.
- **Errors**: a malformed inbound message is logged and dropped at the seam.
  Agent errors surface as `error` events, never as thrown exceptions across
  a seam.

## Decisions Log

- Pi **SDK** over RPC; seam kept RPC-compatible (no Pi types leak out of `agent/`).
- Standalone program, not a Pi extension; Pier registers custom tools into
  the sessions it creates (task tool, step 5).
- Web workbench before IM channels (fastest loop for steering/observability).
- Show pages: static HTML + optional SSE reload; Pi `export_html` for replay.
- Persistence: pi session files now; one SQLite db arrives with step 5.
