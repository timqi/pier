// One append-only event table, read two ways: latest(topic, key) is shared
// state between sessions, log(topic_glob, after) is a message stream. This
// store owns every write path's guards — shape, scope, hop ceiling, rate
// limit — so a future caller (P2 delivery, P3 librarian) cannot publish
// around them.

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
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

/** Shared with subscribe (bus/subs.ts): a pattern that will match topics for
 * the life of a subscription deserves the same gate as a one-off read. */
export const validTopicGlob = (glob: string): boolean =>
  TOPIC_GLOB.test(glob) && glob.length <= 128;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 random bits in Crockford base32 — the
 * lexicographic order that makes `id > cursor` a valid incremental read.
 * Monotonic even against a clock that steps back: an id below an already
 * issued one would make cursored readers skip the event forever, so the
 * generator only counts up, seeded from the newest stored id at boot. */
class Ulid {
  #lastMs = -1;
  #tail = Buffer.alloc(10);

  /** Continue above an id issued by a previous process. */
  seed(id: string): void {
    let ms = 0;
    for (let i = 0; i < 10; i++) ms = ms * 32 + CROCKFORD.indexOf(id[i]!);
    let bits = 0n;
    for (let i = 10; i < 26; i++) bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(id[i]!));
    for (let i = 9; i >= 0; i--, bits >>= 8n) this.#tail[i] = Number(bits & 255n);
    this.#lastMs = ms;
  }

  next(now: number): string {
    if (now > this.#lastMs) {
      this.#lastMs = now;
      this.#tail = randomBytes(10);
    } else {
      // Same millisecond, or a clock step back: increment the previous
      // randomness instead of rolling new, which could sort before it.
      let i = 9;
      while (i >= 0 && ++this.#tail[i]! > 255) this.#tail[i--] = 0;
      // The 80-bit tail wrapped (practically unreachable): move time forward.
      if (i < 0) {
        this.#lastMs++;
        this.#tail = randomBytes(10);
      }
    }
    let time = "";
    for (let i = 0, t = this.#lastMs; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
    let bits = 0n;
    for (const byte of this.#tail) bits = (bits << 8n) | BigInt(byte);
    let rand = "";
    for (let i = 0; i < 16; i++, bits >>= 5n) rand = CROCKFORD[Number(bits & 31n)] + rand;
    return time + rand;
  }
}

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
  readonly #ulid = new Ulid();
  // In memory on purpose: the limit exists to break a publish storm inside one
  // process's lifetime, and a restart resetting it loses nothing worth keeping.
  readonly #recent = new Map<string, number[]>();

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
    const top = this.#db.prepare("SELECT MAX(id) AS id FROM bus_events").get() as { id: string | null };
    if (top.id) this.#ulid.seed(top.id);
  }

  publish(input: PublishInput, now = Date.now()): BusEvent {
    if (!TOPIC.test(input.topic) || input.topic.length > 128) {
      throw new Error("topic must be lowercase [a-z0-9-] segments joined by '/', at most 128 chars");
    }
    const kind = input.kind ?? "event";
    // Key presence is the semantic bit latest() actually reads; a row where
    // the two disagree would sit half in each world, so it never gets written.
    if (kind === "event" && input.key !== undefined) {
      throw new Error("a keyed write is a fact — omit key for a plain event");
    }
    if (kind !== "event" && input.key === undefined) {
      throw new Error(`kind '${kind}' needs a key`);
    }
    if (Buffer.byteLength(input.payload) > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes — write the content to a file and publish its path as file_ptr`);
    }
    try {
      JSON.parse(input.payload);
    } catch {
      // One unparseable row would throw for every reader of every page it is
      // on; refusing the write is the only place this can be caught.
      throw new Error("payload must be a JSON string");
    }
    if (input.ttlSeconds !== undefined) {
      if (kind !== "fact") throw new Error("ttl_seconds applies to facts — a keyed publish");
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new Error("ttl_seconds must be a positive integer");
      }
    }
    if (input.filePtr !== undefined && !isAbsolute(input.filePtr)) {
      throw new Error("file_ptr must be an absolute path");
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
      id: this.#ulid.next(now),
      topic: input.topic,
      key: input.key,
      kind,
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

  /** Value per key: scopes shadow narrow-to-wide (the order of `scopes`), and
   * within a scope the newest write wins — a tombstoned or expired winner ends
   * its own scope's claim without resurfacing older writes there, but a wider
   * scope's live value still shows through. So a project fact overrides an
   * instance default, and forgetting the override reveals the default. */
  latest(topic: string, scopes: readonly string[], key?: string, now = Date.now()): BusEvent[] {
    if (scopes.length === 0) return [];
    const rows = this.#db.prepare(`
      SELECT * FROM bus_events e
      WHERE e.topic = ? AND e.key IS NOT NULL AND e.scope IN (${holes(scopes)})
        ${key === undefined ? "" : "AND e.key = ?"}
        AND e.id = (SELECT MAX(id) FROM bus_events
                    WHERE topic = e.topic AND key = e.key AND scope = e.scope)
      ORDER BY e.key
    `).all(topic, ...scopes, ...(key === undefined ? [] : [key])) as unknown as Row[];
    const byKey = new Map<string, Map<string, BusEvent>>();
    for (const row of rows) {
      const event = fromRow(row);
      const perScope = byKey.get(event.key!) ?? new Map<string, BusEvent>();
      perScope.set(event.scope, event);
      byKey.set(event.key!, perScope);
    }
    const winners: BusEvent[] = [];
    for (const perScope of byKey.values()) {
      for (const scope of scopes) {
        const candidate = perScope.get(scope);
        if (!candidate || !live(candidate, now)) continue; // dead scope: look wider
        winners.push(candidate);
        break;
      }
    }
    return winners;
  }

  /** Incremental read: everything after the cursor, tombstones included —
   * a reader tracking state needs to see the deletions too. */
  log(topicGlob: string, scopes: readonly string[], after = "", limit = 50): { events: BusEvent[]; cursor: string } {
    if (!validTopicGlob(topicGlob)) {
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
  forget(topic: string, key: string, scope: string, writerSession: string, causedBy?: string, now = Date.now()): BusEvent {
    return this.publish(
      { topic, key, kind: "tombstone", payload: "null", scope, writerSession, causedBy },
      now,
    );
  }

  /** Newest id overall — where a new subscription starts hearing from. */
  tip(): string {
    const row = this.#db.prepare("SELECT MAX(id) AS id FROM bus_events").get() as { id: string | null };
    return row.id ?? "";
  }

  /** How many events a cursor is behind — the number a pointer notification
   * carries, computed at delivery time so it is true when read. */
  countSince(topicGlob: string, scopes: readonly string[], after: string): number {
    if (scopes.length === 0) return 0;
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS n FROM bus_events
      WHERE topic GLOB ? AND id > ? AND scope IN (${holes(scopes)})
    `).get(topicGlob, after, ...scopes) as { n: number };
    return row.n;
  }

  byId(id: string): BusEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM bus_events WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  #throttle(writer: string, topic: string, now: number): void {
    // Buckets for dead sessions and one-off topics would otherwise sit in the
    // map for the life of the process; sweep once it is visibly not small.
    if (this.#recent.size > 512) {
      for (const [bucket, at] of this.#recent) {
        const kept = at.filter((t) => now - t < RATE_WINDOW_MS);
        if (kept.length === 0) this.#recent.delete(bucket);
        else this.#recent.set(bucket, kept);
      }
    }
    const bucket = `${writer}\n${topic}`;
    const stamps = (this.#recent.get(bucket) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (stamps.length >= RATE_LIMIT) {
      throw new Error(`rate limit: more than ${RATE_LIMIT} events on '${topic}' in a minute — batch the writes or move the content to a file`);
    }
    stamps.push(now);
    this.#recent.set(bucket, stamps);
  }
}
