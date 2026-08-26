// The model-facing `bus` tool: publish/get/log/forget over BusStore, plus the
// one policy the store cannot own — which scope a caller writes into and which
// scopes it may read, resolved from the calling session.

import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { BusStore, validTopicGlob, type BusEvent } from "./store.js";
import type { BusSubMode, SubStore } from "./subs.js";

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
 * run trees, the agent factory knows cwds) — bus never imports either.
 * `rootRunId` is the tree the session is the target of (its default write
 * scope); `invokedRootRunIds` are active trees it delegated, which it may
 * read — without them a coordinator's `get` would return null on its own
 * children's blackboard, indistinguishable from "no fact". */
export interface BusCaller {
  resolve(sessionId: string): Promise<{ rootRunId?: string; cwd?: string; invokedRootRunIds?: string[] }>;
}

/** The tool's collaborators, wired in main.ts. `notify` is fire-and-forget —
 * a publish must not wait on its readers' turns. */
export interface BusToolDeps {
  store: BusStore;
  subs: SubStore;
  caller: BusCaller;
  notify: (event: BusEvent) => void;
  /** The capability switch. The tool is hidden from new sessions when off
   * (pi.ts reads `enabled` at open); this is the backstop for sessions that
   * opened before the operator flipped it. */
  enabled: () => boolean;
}

/** Model-facing event shape: payload parsed back to a value. */
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

/** The stream additionally names the writer and the causal depth — a reader
 * skipping its own events or debugging a storm acts on both. */
const echoStream = (event: BusEvent) => ({
  ...echo(event),
  writer_session: event.writerSession,
  hops: event.hops,
});

export function busToolSpec(execute: AgentCustomTool["execute"]): AgentCustomTool {
  return {
    name: "bus",
    label: "Pier Bus",
    description:
      "Append-only event log shared across sessions; one table, two reads. " +
      "get {topic, key?, scope?} reads shared state: the newest value per (topic, key), narrower scopes shadowing wider ones; scope reads one scope without the shadowing. " +
      "log {topic_glob, after?, limit?} reads the stream: events after a cursor in write order, returning the next cursor — use it to catch up, then pass the cursor back in; a glob exactly matching one of your subscriptions reads that subscription's pinned scopes instead of your live ones, and the response says so in pinned_scopes (unsubscribe restores your live scopes, re-subscribing re-pins them). " +
      "publish {topic, key?, payload, ...} appends: with key it is a fact that overwrites in get; without key a plain event. " +
      "forget {topic, key, scope?} deletes a fact (as a tombstone) in the scope where the visible winner lives, and the value stops being findable by search too; when that winner is instance-wide, pass scope 'instance' to confirm deleting it for every project. " +
      "search {query, scope?, limit?} is full-text over topic and payload (FTS5: words, \"quoted phrases\", AND/OR/NOT), most relevant first; scope narrows to one of your scopes. Only a fact's current value is searchable — superseded, forgotten and expired ones are not — so a hit is never a retracted value; archived events are not searched either (log {include_archived: true} reaches those). " +
      "topics {} lists every visible topic with its event count, newest id, newest timestamp and when anyone last read it (epoch ms, null = never). " +
      "archive {topic_glob, before, scope?} moves matched events with id <= before, in one scope (default: your narrowest), out of every default read (log {include_archived: true} still reaches them) — for aged topics nobody reads, not for deleting mistakes (that is forget); before must be a live event id there. " +
      "peek: true on get/log reads without counting as a reader — for maintenance passes over topics you do not consume, so they can still age out. " +
      "subscribe {topic_glob, mode?} asks to be told about writes you can see: mode 'queue' (default) delivers a pointer at your next turn boundary, 'steer' interrupts your running turn, 'wake' is 'queue' that also starts your turn when idle (they differ only when busy). The notification is a pointer, never the payload — read with log, then ack {topic_glob, cursor} to confirm progress (the cursor only moves forward); unsubscribe {topic_glob} stops it. " +
      "Topics are lowercase 'a/b/c' paths. Keep payload small (JSON, 8KB max); write large content to a file and pass its absolute path as file_ptr. " +
      "Scope defaults to your run tree when you are a subagent, else your project; pass scope 'instance' only for facts every project should see. A narrower scope's fact shadows a wider one's under the same key; run scope lives only while its run tree is active. " +
      "When you publish in reaction to an event you read, pass that event's id as caused_by — chains deeper than 4 are refused as feedback loops.",
    parameters: Type.Object({
      operation: strEnum("publish", "get", "log", "forget", "subscribe", "unsubscribe", "ack", "search", "topics", "archive"),
      mode: Type.Optional(strEnum("queue", "steer", "wake")),
      cursor: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      before: Type.Optional(Type.String()),
      include_archived: Type.Optional(Type.Boolean()),
      peek: Type.Optional(Type.Boolean()),
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
  deps: BusToolDeps,
  raw: unknown,
  callerSessionId: string,
): Promise<unknown> {
  const { store, subs, caller, notify } = deps;
  if (!deps.enabled()) {
    throw new Error("the bus is switched off — the operator can enable it in Console → Bus");
  }
  const input = record(raw);
  if (!input) throw new Error("bus tool parameters required");
  const { rootRunId, cwd, invokedRootRunIds = [] } = await caller.resolve(callerSessionId);
  // Narrowest first — the order is also latest()'s shadowing order: the run
  // trees the caller stands in, its project, then the instance blackboard.
  const runRoots = [...new Set([...(rootRunId ? [rootRunId] : []), ...invokedRootRunIds])];
  const scopes = [
    ...runRoots.map((root) => `run:${root}`),
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
        scope: writeScope(input.scope, rootRunId, cwd, invokedRootRunIds),
        writerSession: callerSessionId,
        causedBy: input.caused_by === undefined ? undefined : requiredString(input.caused_by, "caused_by"),
        ttlSeconds: input.ttl_seconds === undefined ? undefined : Number(input.ttl_seconds),
      });
      notify(event);
      return { id: event.id, scope: event.scope };
    }
    case "get": {
      const values = store.latest(
        requiredString(input.topic, "topic"),
        // Narrowed, a get answers "what does *this* scope say" — without it a
        // project fact shadows the instance one under the same key, and a
        // maintenance pass can never see past the override.
        input.scope === undefined ? scopes : [writeScope(input.scope, rootRunId, cwd, invokedRootRunIds)],
        input.key === undefined ? undefined : requiredString(input.key, "key"),
        undefined,
        input.peek === true,
      );
      return input.key === undefined ? values.map(echo) : (values[0] ? echo(values[0]) : null);
    }
    case "log": {
      if (input.limit !== undefined && !Number.isInteger(input.limit)) {
        throw new Error("limit must be an integer");
      }
      const glob = requiredString(input.topic_glob, "topic_glob");
      // A subscription's log view is its pinned scopes: the pointer's count
      // was computed against them, and a run-scoped subscriber must be able
      // to drain its own backlog after the run tree ends — with live scopes
      // it would be woken for events its log can no longer show.
      const pinned = subs.get(callerSessionId, glob)?.scopes;
      const { events, cursor } = store.log(
        glob,
        pinned ?? scopes,
        input.after === undefined ? "" : String(input.after),
        input.limit as number | undefined,
        input.include_archived === true,
        input.peek === true,
      );
      // A re-fenced read must say so: the same glob without the subscription
      // answers from live scopes, and a fence the response never names is a
      // silent change of the query's meaning.
      return {
        events: events.map(echoStream),
        cursor,
        ...(pinned === undefined ? {} : { pinned_scopes: pinned }),
      };
    }
    case "search": {
      if (input.limit !== undefined && !Number.isInteger(input.limit)) {
        throw new Error("limit must be an integer");
      }
      const hits = store.search(
        requiredString(input.query, "query"),
        // The plan's scope param: narrow the fence, never widen it.
        input.scope === undefined ? scopes : [writeScope(input.scope, rootRunId, cwd, invokedRootRunIds)],
        input.limit as number | undefined,
      );
      return hits.map(echoStream);
    }
    case "topics":
      return store.topics(scopes);
    case "archive": {
      const moved = store.archive(
        requiredString(input.topic_glob, "topic_glob"),
        requiredString(input.before, "before"),
        // One scope, explicit or the caller's narrowest — an archive that
        // swept every visible scope would take other projects' history along.
        writeScope(input.scope, rootRunId, cwd, invokedRootRunIds),
      );
      return { archived: moved };
    }
    case "forget": {
      const topic = requiredString(input.topic, "topic");
      const key = requiredString(input.key, "key");
      // The tombstone lands where the visible winner lives: forgetting a
      // project override in the caller's default (run) scope would only mask
      // it for the run and let it resurface when the run ends.
      const winner = input.scope === undefined ? store.latest(topic, scopes, key)[0] : undefined;
      // Following the winner stops at the instance boundary: publish refuses
      // to land there implicitly, and a deletion every project sees deserves
      // the same explicitness — the winner-follow must not become the way
      // around writeScope's refusal.
      if (winner?.scope === "instance") {
        throw new Error(`the live fact for '${key}' is instance-wide — pass scope 'instance' to confirm deleting it for every project`);
      }
      const event = store.forget(
        topic,
        key,
        winner?.scope ?? writeScope(input.scope, rootRunId, cwd, invokedRootRunIds),
        callerSessionId,
        input.caused_by === undefined ? undefined : requiredString(input.caused_by, "caused_by"),
      );
      notify(event);
      return { id: event.id, scope: event.scope };
    }
    case "subscribe": {
      const glob = requiredString(input.topic_glob, "topic_glob");
      if (!validTopicGlob(glob)) {
        throw new Error("topic_glob may use the topic alphabet plus GLOB wildcards (* ? [])");
      }
      const mode = (input.mode ?? "queue") as BusSubMode;
      if (mode !== "queue" && mode !== "steer" && mode !== "wake") {
        throw new Error("mode must be 'queue', 'steer' or 'wake'");
      }
      // Scopes pinned now, cursor starting at the tip: a subscription hears
      // the future, not a replay of everything it could already have read.
      const sub = subs.upsert(callerSessionId, glob, mode, scopes, store.tip());
      return { sub_id: sub.id, topic_glob: sub.topicGlob, mode: sub.mode, cursor: sub.cursor, scopes: sub.scopes };
    }
    case "unsubscribe": {
      const glob = requiredString(input.topic_glob, "topic_glob");
      if (!subs.remove(callerSessionId, glob)) {
        throw new Error(`no subscription on '${glob}'`);
      }
      return { removed: glob };
    }
    case "ack": {
      const glob = requiredString(input.topic_glob, "topic_glob");
      const cursor = requiredString(input.cursor, "cursor");
      const owned = subs.get(callerSessionId, glob);
      if (!owned) {
        throw new Error(`no subscription on '${glob}' — subscribe first`);
      }
      // The cursor must be an event this subscription actually reads: a made-up
      // id above every real one — or a real id from an unrelated topic — would
      // skip the unread backlog forever, and nothing anywhere would say why.
      if (!store.seenBy(cursor, owned.topicGlob, owned.scopes)) {
        throw new Error("cursor must be the id of an event this subscription reads (from log)");
      }
      const sub = subs.ack(callerSessionId, glob, cursor);
      return { topic_glob: sub.topicGlob, cursor: sub.cursor };
    }
    default:
      throw new Error(`unknown bus operation: ${String(input.operation)}`);
  }
}

/** Explicit wins; otherwise the narrowest scope the caller provably stands in.
 * A caller neither in a run nor in a known cwd gets an error, not a silent
 * widening to instance — a leaked blackboard is harder to clean up than a
 * missing one. */
function writeScope(requested: unknown, rootRunId?: string, cwd?: string, invoked: string[] = []): string {
  if (requested !== undefined) {
    if (requested === "run") {
      // A coordinator may address the one tree it is running; two would be a
      // guess, and guessing a scope is how a blackboard leaks.
      const root = rootRunId ?? (invoked.length === 1 ? invoked[0] : undefined);
      if (!root) {
        throw new Error(invoked.length > 1
          ? "scope 'run' is ambiguous: several active run trees — P1 cannot address one by id"
          : "scope 'run' needs a caller inside (or running) a task run");
      }
      return `run:${root}`;
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
