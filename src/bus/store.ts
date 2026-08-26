// One append-only event table, read two ways: latest(topic, key) is shared
// state between sessions, log(topic_glob, after) is a message stream. This
// store owns every write path's guards — scope, hop ceiling, rate limit — so
// a future caller (P2 delivery, P3 librarian) cannot publish around them.

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";

export type BusKind = "event" | "fact" | "tombstone";

export interface BusEvent {
  id: string;
  topic: string;
  key?: string;
  kind: BusKind;
  /** JSON string as stored; callers parse it back at the boundary. */
  payload: string;
  filePtr?: string;
  scope: string;
  writerSession: string;
  causedBy?: string;
  hops: number;
  ttlSeconds?: number;
  createdAt: string;
}

export interface PublishInput {
  topic: string;
  key?: string;
  kind?: BusKind;
  payload: string;
  filePtr?: string;
  scope: string;
  writerSession: string;
  causedBy?: string;
  ttlSeconds?: number;
}

/** Payload lives in every reader's context; big content belongs in a file. */
export const MAX_PAYLOAD_BYTES = 8192;
/** A causal chain longer than this is a feedback loop, not a workflow. */
export const MAX_HOPS = 4;
/** Per (writer, topic): more than this per minute is a storm, not a writer. */
export const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const TOPIC = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
// GLOB metacharacters on top of the topic alphabet; the pattern is a bound
// SQL parameter, so this only rejects nonsense early, not injection.
const TOPIC_GLOB = /^[a-z0-9\-/*?[\]]+$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 random bits in Crockford base32 — the
 * lexicographic order that makes `id > cursor` a valid incremental read.
 * Monotonic within the process: two events in one millisecond still sort in
 * write order, or a cursor could skip its sibling. */
const ulid = (() => {
  let lastMs = -1;
  let tail: Buffer;
  return (now: number): string => {
    if (now > lastMs) {
      lastMs = now;
      tail = randomBytes(10);
    } else {
      // Same millisecond (or a clock step back): increment the previous
      // randomness instead of rolling new, which could sort before it.
      for (let i = 9; i >= 0 && ++tail![i]! > 255; i--) tail![i] = 0;
    }
    let time = "";
    for (let i = 0, t = lastMs; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
    // 80 bits read as 16 five-bit groups, high to low.
    let value = 0n;
    for (const byte of tail!) value = (value << 8n) | BigInt(byte);
    let rand = "";
    for (let i = 0; i < 16; i++, value >>= 5n) rand = CROCKFORD[Number(value & 31n)] + rand;
    return time + rand;
  };
})();

interface Row {
  id: string;
  topic: string;
  key: string | null;
  kind: BusKind;
  payload: string;
  file_ptr: string | null;
  scope: string;
  writer_session: string;
  caused_by: string | null;
  hops: number;
  ttl_seconds: number | null;
  created_at: string;
}

const fromRow = (row: Row): BusEvent => ({
  id: row.id,
  topic: row.topic,
  key: row.key ?? undefined,
  kind: row.kind,
  payload: row.payload,
  filePtr: row.file_ptr ?? undefined,
  scope: row.scope,
  writerSession: row.writer_session,
  causedBy: row.caused_by ?? undefined,
  hops: row.hops,
  ttlSeconds: row.ttl_seconds ?? undefined,
  createdAt: row.created_at,
});

const live = (event: BusEvent, nowMs: number): boolean =>
  event.kind !== "tombstone" &&
  (event.ttlSeconds === undefined ||
    Date.parse(event.createdAt) + event.ttlSeconds * 1000 > nowMs);

const holes = (scopes: readonly string[]): string => scopes.map(() => "?").join(", ");

export class BusStore {
  readonly #db: DatabaseSync;
  // In memory on purpose: the limit exists to break a publish storm inside one
  // process's lifetime, and a restart resetting it loses nothing worth keeping.
  readonly #recent = new Map<string, number[]>();

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  publish(input: PublishInput, now = Date.now()): BusEvent {
    if (!TOPIC.test(input.topic) || input.topic.length > 128) {
      throw new Error("topic must be lowercase [a-z0-9-] segments joined by '/', at most 128 chars");
    }
    if (Buffer.byteLength(input.payload) > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes — write the content to a file and publish its path as file_ptr`);
    }
    if (input.ttlSeconds !== undefined && (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0)) {
      throw new Error("ttl_seconds must be a positive integer");
    }
    let hops = 0;
    if (input.causedBy) {
      const parent = this.byId(input.causedBy);
      if (!parent) throw new Error(`caused_by event ${input.causedBy} not found`);
      hops = parent.hops + 1;
      if (hops > MAX_HOPS) {
        throw new Error(`causal chain exceeds ${MAX_HOPS} hops — this write is ${hops} reactions deep, which is a feedback loop; stop reacting to this event`);
      }
    }
    this.#throttle(input.writerSession, input.topic, now);
    const event: BusEvent = {
      id: ulid(now),
      topic: input.topic,
      key: input.key,
      kind: input.kind ?? "event",
      payload: input.payload,
      filePtr: input.filePtr,
      scope: input.scope,
      writerSession: input.writerSession,
      causedBy: input.causedBy,
      hops,
      ttlSeconds: input.ttlSeconds,
      createdAt: new Date(now).toISOString(),
    };
    this.#db.prepare(`
      INSERT INTO bus_events(id, topic, key, kind, payload, file_ptr, scope,
                             writer_session, caused_by, hops, ttl_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.topic, event.key ?? null, event.kind, event.payload,
      event.filePtr ?? null, event.scope, event.writerSession,
      event.causedBy ?? null, event.hops, event.ttlSeconds ?? null, event.createdAt,
    );
    return event;
  }

  /** Newest visible write per (topic, key); a key whose winner is a tombstone
   * or an expired fact has no value — an older write does not resurface. */
  latest(topic: string, scopes: readonly string[], key?: string, now = Date.now()): BusEvent[] {
    if (scopes.length === 0) return [];
    const rows = this.#db.prepare(`
      SELECT * FROM bus_events e
      WHERE e.topic = ? AND e.key IS NOT NULL AND e.scope IN (${holes(scopes)})
        ${key === undefined ? "" : "AND e.key = ?"}
        AND e.id = (SELECT MAX(id) FROM bus_events
                    WHERE topic = e.topic AND key = e.key AND scope IN (${holes(scopes)}))
      ORDER BY e.key
    `).all(topic, ...scopes, ...(key === undefined ? [] : [key]), ...scopes) as unknown as Row[];
    return rows.map(fromRow).filter((event) => live(event, now));
  }

  /** Incremental read: everything after the cursor, tombstones included —
   * a reader tracking state needs to see the deletions too. */
  log(topicGlob: string, scopes: readonly string[], after = "", limit = 50): { events: BusEvent[]; cursor: string } {
    if (!TOPIC_GLOB.test(topicGlob) || topicGlob.length > 128) {
      throw new Error("topic_glob may use the topic alphabet plus GLOB wildcards (* ? [])");
    }
    if (scopes.length === 0) return { events: [], cursor: after };
    const rows = this.#db.prepare(`
      SELECT * FROM bus_events
      WHERE topic GLOB ? AND id > ? AND scope IN (${holes(scopes)})
      ORDER BY id LIMIT ?
    `).all(topicGlob, after, ...scopes, Math.min(Math.max(limit, 1), 200)) as unknown as Row[];
    const events = rows.map(fromRow);
    return { events, cursor: events.at(-1)?.id ?? after };
  }

  /** A deletion is a tombstone event, never a DELETE: readers syncing by
   * cursor must see it, and a future multi-host merge cannot union an absence. */
  forget(topic: string, key: string, scope: string, writerSession: string, now = Date.now()): BusEvent {
    return this.publish(
      { topic, key, kind: "tombstone", payload: "null", scope, writerSession },
      now,
    );
  }

  byId(id: string): BusEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM bus_events WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  #throttle(writer: string, topic: string, now: number): void {
    const bucket = `${writer}\n${topic}`;
    const stamps = (this.#recent.get(bucket) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (stamps.length >= RATE_LIMIT) {
      throw new Error(`rate limit: more than ${RATE_LIMIT} events on '${topic}' in a minute — batch the writes or move the content to a file`);
    }
    stamps.push(now);
    this.#recent.set(bucket, stamps);
  }
}
