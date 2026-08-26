// The model-facing `bus` tool: publish/get/log/forget over BusStore, plus the
// one policy the store cannot own — which scope a caller writes into and which
// scopes it may read, resolved from the calling session.

import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { BusStore, type BusEvent } from "./store.js";

const strEnum = <const T extends readonly string[]>(...values: T) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values] });

// Second copy of tasks/definitions.ts's boundary helpers, not an import:
// runtime dependencies never go sideways between areas (docs/architecture.md).
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} required`);
  return value.trim();
};

/** Where a caller stands, answered by whoever owns that knowledge (tasks know
 * run trees, the agent factory knows cwds) — bus never imports either. */
export interface BusCaller {
  resolve(sessionId: string): Promise<{ rootRunId?: string; cwd?: string }>;
}

/** Model-facing event shape: payload parsed back to a value, bookkeeping the
 * reader cannot act on (hops, writer) left out of `get`, kept in `log`. */
const echo = (event: BusEvent) => ({
  id: event.id,
  topic: event.topic,
  ...(event.key === undefined ? {} : { key: event.key }),
  kind: event.kind,
  payload: JSON.parse(event.payload) as unknown,
  ...(event.filePtr === undefined ? {} : { file_ptr: event.filePtr }),
  scope: event.scope,
  ...(event.causedBy === undefined ? {} : { caused_by: event.causedBy }),
  created_at: event.createdAt,
});

export function busToolSpec(execute: AgentCustomTool["execute"]): AgentCustomTool {
  return {
    name: "bus",
    label: "Pier Bus",
    description:
      "Append-only event log shared across sessions; one table, two reads. " +
      "get {topic, key?} reads shared state: the newest value per (topic, key) — use it for facts other sessions maintain. " +
      "log {topic_glob, after?, limit?} reads the stream: events after a cursor in write order, returning the next cursor — use it to catch up, then pass the cursor back in. " +
      "publish {topic, key?, payload, ...} appends: with key it is a fact that overwrites in get; without key a plain event. " +
      "forget {topic, key} deletes a fact (as a tombstone). " +
      "Topics are lowercase 'a/b/c' paths. Keep payload small (JSON, 8KB max); write large content to a file and pass its absolute path as file_ptr. " +
      "Scope defaults to your run tree when you are a subagent, else your project; pass scope 'instance' only for facts every project should see. " +
      "When you publish in reaction to an event you read, pass that event's id as caused_by — chains deeper than 4 are refused as feedback loops.",
    parameters: Type.Object({
      operation: strEnum("publish", "get", "log", "forget"),
      topic: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Unknown()),
      file_ptr: Type.Optional(Type.String()),
      scope: Type.Optional(strEnum("run", "project", "instance")),
      caused_by: Type.Optional(Type.String()),
      ttl_seconds: Type.Optional(Type.Number()),
      topic_glob: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    execute,
  };
}

export async function handleBusTool(
  store: BusStore,
  caller: BusCaller,
  raw: unknown,
  callerSessionId: string,
): Promise<unknown> {
  const input = record(raw);
  if (!input) throw new Error("bus tool parameters required");
  const { rootRunId, cwd } = await caller.resolve(callerSessionId);
  // Narrowest first: what the caller writes by default is also everything it
  // may read — its own run tree, its project, and the instance blackboard.
  const scopes = [
    ...(rootRunId ? [`run:${rootRunId}`] : []),
    ...(cwd ? [`project:${cwd}`] : []),
    "instance",
  ];

  switch (input.operation) {
    case "publish": {
      if (input.payload === undefined) throw new Error("payload required");
      const key = input.key === undefined ? undefined : requiredString(input.key, "key");
      const event = store.publish({
        topic: requiredString(input.topic, "topic"),
        key,
        // A keyed write is state (participates in get, may carry a TTL); an
        // unkeyed one is a moment. The caller says which by shape, not name.
        kind: key === undefined ? "event" : "fact",
        payload: JSON.stringify(input.payload),
        filePtr: input.file_ptr === undefined ? undefined : requiredString(input.file_ptr, "file_ptr"),
        scope: writeScope(input.scope, rootRunId, cwd),
        writerSession: callerSessionId,
        causedBy: input.caused_by === undefined ? undefined : requiredString(input.caused_by, "caused_by"),
        ttlSeconds: input.ttl_seconds === undefined ? undefined : Number(input.ttl_seconds),
      });
      return { id: event.id, scope: event.scope };
    }
    case "get": {
      const values = store.latest(
        requiredString(input.topic, "topic"),
        scopes,
        input.key === undefined ? undefined : requiredString(input.key, "key"),
      );
      return input.key === undefined ? values.map(echo) : (values[0] ? echo(values[0]) : null);
    }
    case "log": {
      const { events, cursor } = store.log(
        requiredString(input.topic_glob, "topic_glob"),
        scopes,
        input.after === undefined ? "" : String(input.after),
        input.limit === undefined ? undefined : Number(input.limit),
      );
      return { events: events.map(echo), cursor };
    }
    case "forget": {
      const event = store.forget(
        requiredString(input.topic, "topic"),
        requiredString(input.key, "key"),
        writeScope(input.scope, rootRunId, cwd),
        callerSessionId,
      );
      return { id: event.id, scope: event.scope };
    }
    default:
      throw new Error(`unknown bus operation: ${String(input.operation)}`);
  }
}

/** Explicit wins; otherwise the narrowest scope the caller provably stands in.
 * A caller neither in a run nor in a known cwd gets an error, not a silent
 * widening to instance — a leaked blackboard is harder to clean up than a
 * missing one. */
function writeScope(requested: unknown, rootRunId?: string, cwd?: string): string {
  if (requested !== undefined) {
    if (requested === "run") {
      if (!rootRunId) throw new Error("scope 'run' needs a caller inside a task run");
      return `run:${rootRunId}`;
    }
    if (requested === "project") {
      if (!cwd) throw new Error("scope 'project' needs a caller with a known working directory");
      return `project:${cwd}`;
    }
    if (requested === "instance") return "instance";
    throw new Error("scope must be 'run', 'project' or 'instance'");
  }
  if (rootRunId) return `run:${rootRunId}`;
  if (cwd) return `project:${cwd}`;
  throw new Error("could not infer a scope for this session — pass scope explicitly");
}
