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
    // Both tables: archiving the live tip must not let a clock step mint ids
    // below history, or a cursor could skip the next event forever.
    const top = this.#db.prepare(`
      SELECT MAX(id) AS id FROM (
        SELECT MAX(id) AS id FROM bus_events
        UNION ALL SELECT MAX(id) FROM bus_events_archive)
    `).get() as { id: string | null };
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
    // The FTS index follows by trigger (db.ts migration 9), atomically.
    return event;
  }

  /** Full-text over topic and payload, visible scopes only, most relevant
   * first (newest breaks ties). Archived events are not searched: what nobody
   * read while it was live is not what a search is looking for. */
  search(query: string, scopes: readonly string[], limit = 20): BusEvent[] {
    if (!query.trim()) throw new Error("query required");
    if (scopes.length === 0) return [];
    // Scope inside the query, not after the cap: a page of better-ranked hits
    // the caller may not see must not starve the ones it may.
    const match = (q: string): Row[] =>
      this.#db.prepare(`
        SELECT e.* FROM bus_events_fts f JOIN bus_events e ON e.id = f.id
        WHERE bus_events_fts MATCH ? AND e.scope IN (${holes(scopes)})
        ORDER BY f.rank, e.id DESC LIMIT ?
      `).all(q, ...scopes, Math.min(Math.max(limit, 1), 100)) as unknown as Row[];
    try {
      return match(query).map(fromRow);
    } catch {
      // FTS5's query language treats a bare hyphen (or colon, or unbalanced
      // quote) as syntax — and "nothing-here" is a perfectly reasonable thing
      // to search for. Retry with every token quoted: plain text always works,
      // operator syntax still available to whoever writes it correctly.
      try {
        return match(query.split(/\s+/).filter(Boolean)
          .map((token) => `"${token.replaceAll('"', '""')}"`).join(" ")).map(fromRow);
      } catch {
        throw new Error('not a valid search query — use words, "quoted phrases", AND/OR/NOT');
      }
    }
  }

  /** Moves everything a pattern matches in *one* scope, up to and including
   * `before`, into the archive — out of every default read but never deleted
   * (the rows move whole, so a future need can move them back). One scope on
   * purpose: a librarian summarizing into its own scope must not take other
   * scopes' history with it. `before` must name a real event the caller sees
   * there — an arbitrary boundary like 'ZZZZ' would archive a scope whole,
   * live facts included, with no restore tool. */
  archive(topicGlob: string, before: string, scope: string): number {
    if (!validTopicGlob(topicGlob)) {
      throw new Error("topic_glob may use the topic alphabet plus GLOB wildcards (* ? [])");
    }
    const anchor = this.#db.prepare(
      "SELECT 1 AS hit FROM bus_events WHERE id = ? AND topic GLOB ? AND scope = ?",
    ).get(before, topicGlob, scope);
    if (!anchor) throw new Error("before must be the id of a live event matching topic_glob in the target scope");
    const move = "topic GLOB ? AND id <= ? AND scope = ?";
    // A savepoint, not BEGIN: composable if a caller ever owns a transaction.
    this.#db.exec("SAVEPOINT bus_archive");
    try {
      this.#db.prepare(`INSERT INTO bus_events_archive SELECT * FROM bus_events WHERE ${move}`)
        .run(topicGlob, before, scope);
      // The FTS rows follow the DELETE by trigger.
      const moved = this.#db.prepare(`DELETE FROM bus_events WHERE ${move}`).run(topicGlob, before, scope);
      this.#db.exec("RELEASE bus_archive");
      return Number(moved.changes);
    } catch (err) {
      this.#db.exec("ROLLBACK TO bus_archive");
      this.#db.exec("RELEASE bus_archive");
      throw err;
    }
  }

  /** Per-(topic, scope) shape of the visible bus — what the librarian reasons
   * over: how much, how fresh (as a timestamp it can do arithmetic on), and
   * when anyone last read it (epoch ms; null = never). Split by scope because
   * archive targets one scope: an aggregate row spanning scopes could name no
   * usable boundary. Read stamps stay topic-grained — reading is one act
   * whatever scope answered. */
  topics(scopes: readonly string[]): {
    topic: string; scope: string; events: number; newestId: string; newestCreatedAt: string; lastReadAt: number | null;
  }[] {
    if (scopes.length === 0) return [];
    return this.#db.prepare(`
      SELECT e.topic, e.scope, COUNT(*) AS events, MAX(e.id) AS newestId,
             MAX(e.created_at) AS newestCreatedAt, r.last_read_at AS lastReadAt
      FROM bus_events e LEFT JOIN bus_topic_reads r ON r.topic = e.topic
      WHERE e.scope IN (${holes(scopes)})
      GROUP BY e.topic, e.scope ORDER BY e.topic, e.scope
    `).all(...scopes) as unknown as {
      topic: string; scope: string; events: number; newestId: string; newestCreatedAt: string; lastReadAt: number | null;
    }[];
  }

  /** Value per key: scopes shadow narrow-to-wide (the order of `scopes`), and
   * within a scope the newest write wins — a tombstoned or expired winner ends
   * its own scope's claim without resurfacing older writes there, but a wider
   * scope's live value still shows through. So a project fact overrides an
   * instance default, and forgetting the override reveals the default. */
  latest(topic: string, scopes: readonly string[], key?: string, now = Date.now(), peek = false): BusEvent[] {
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
    // Asking is reading — the stamp lands even on an empty answer — and it
    // lands after the read, not in front of it.
    if (!peek) this.stampRead([topic], now);
    return winners;
  }

  /** Incremental read: everything after the cursor, tombstones included —
   * a reader tracking state needs to see the deletions too. Archived events
   * only on request: the default reader wants the live stream, the librarian
   * (and whoever audits it) wants history. */
  log(
    topicGlob: string,
    scopes: readonly string[],
    after = "",
    limit = 50,
    includeArchived = false,
    peek = false,
  ): { events: BusEvent[]; cursor: string } {
    if (!validTopicGlob(topicGlob)) {
      throw new Error("topic_glob may use the topic alphabet plus GLOB wildcards (* ? [])");
    }
    if (scopes.length === 0) return { events: [], cursor: after };
    const where = `topic GLOB ? AND id > ? AND scope IN (${holes(scopes)})`;
    const params = [topicGlob, after, ...scopes];
    const rows = this.#db.prepare(includeArchived
      ? `SELECT * FROM (SELECT * FROM bus_events WHERE ${where}
         UNION ALL SELECT * FROM bus_events_archive WHERE ${where})
         ORDER BY id LIMIT ?`
      : `SELECT * FROM bus_events WHERE ${where} ORDER BY id LIMIT ?`,
    ).all(...(includeArchived ? [...params, ...params] : params), Math.min(Math.max(limit, 1), 200)) as unknown as Row[];
    const events = rows.map(fromRow);
    // A page with events stamps their topics from the rows already in hand —
    // no extra query on the hot path. An *empty* page still stamps every
    // topic the pattern reaches: a poller at its cursor reads 0 events and is
    // still a reader, and archiving a topic someone actively monitors is the
    // bug this stamp exists to stop. That poll was cheap; the DISTINCT walks
    // the (topic, id) index once and pays for the retention answer.
    if (!peek) {
      const read = events.length > 0
        ? events.map((event) => event.topic)
        : (this.#db.prepare(
            `SELECT DISTINCT topic FROM bus_events WHERE topic GLOB ? AND scope IN (${holes(scopes)})`,
          ).all(topicGlob, ...scopes) as unknown as { topic: string }[]).map((row) => row.topic);
      this.stampRead(read);
    }
    return { events, cursor: events.at(-1)?.id ?? after };
  }

  /** A topic was read — the one fact the librarian's archiving question needs.
   * Called by the read paths themselves so no caller can forget it; hourly
   * granularity, because "read this month?" never needs the exact millisecond
   * and the read paths are hot. */
  stampRead(topicsRead: string[], now = Date.now()): void {
    const stamp = this.#db.prepare(`
      INSERT INTO bus_topic_reads(topic, last_read_at) VALUES (?, ?)
      ON CONFLICT(topic) DO UPDATE SET last_read_at = excluded.last_read_at
      WHERE excluded.last_read_at - last_read_at > 3600000
    `);
    for (const topic of new Set(topicsRead)) stamp.run(topic, now);
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

  /** Whether one event is readable through a pattern and scope set — the
   * test an ack cursor must pass: an id from an unrelated topic or scope
   * would silently skip the subscription's unread backlog. Archive included:
   * a cursor a reader legitimately holds must not become un-ackable because
   * the librarian moved the row. */
  seenBy(id: string, topicGlob: string, scopes: readonly string[]): boolean {
    if (scopes.length === 0) return false;
    const fence = `id = ? AND topic GLOB ? AND scope IN (${holes(scopes)})`;
    const row = this.#db.prepare(`
      SELECT 1 AS hit FROM bus_events WHERE ${fence}
      UNION ALL SELECT 1 FROM bus_events_archive WHERE ${fence}
    `).get(id, topicGlob, ...scopes, id, topicGlob, ...scopes);
    return row !== undefined;
  }

  /** Identity lookup, archive included: hops accounting (caused_by) and cursor
   * validation must keep working on history the librarian moved. */
  byId(id: string): BusEvent | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM bus_events WHERE id = ?
      UNION ALL SELECT * FROM bus_events_archive WHERE id = ?
    `).get(id, id) as unknown as Row | undefined;
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
