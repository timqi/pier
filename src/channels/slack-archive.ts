// The message cache behind the agent-facing Slack tool.
//
// Reads are answered from SQLite when they can be, and only the gap goes to
// Slack — history is immutable once written, so a window we have already synced
// can never change, and re-fetching it would burn rate limit for the same bytes.
//
// The subtle part is not the rows, it is knowing *what we have*. A table of
// messages cannot tell you whether a window was empty or never fetched, so
// coverage is tracked separately: `slack_sync` records the contiguous span each
// conversation is synced over. Widening that span on a disjoint fetch would
// claim coverage of the gap in between and silently serve a hole as an answer,
// so it is only widened when the new window actually touches it.

import type { DatabaseSync } from "node:sqlite";
import { defaultChannelDbPath, openChannelDb } from "./db.js";
import type { SlackMessageEvent } from "./slack-api.js";

/** One cached message, in the shape the tool hands to the agent. */
export interface ArchivedMessage {
  channel: string;
  ts: string;
  /** ISO 8601, derived — a model should not have to decode a Slack ts. */
  at: string;
  threadTs: string | null;
  userId: string | null;
  text: string;
}

/** How far a conversation is synced. `null` when it never has been. */
export interface SyncSpan {
  oldestTs: string;
  newestTs: string;
  syncedAt: number;
}

interface MessageRow {
  channel: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string;
}

/**
 * A Slack `ts` is `<epoch seconds>.<microseconds>` and sorts correctly as a
 * number but *not* as a string once the integer part changes width. Comparisons
 * and ordering therefore go through this, and the column is REAL.
 */
export const tsToNumber = (ts: string): number => Number(ts);

export const tsToIso = (ts: string): string =>
  new Date(Math.floor(tsToNumber(ts) * 1000)).toISOString();

/** Accepts an ISO date, an epoch-seconds number, or a raw Slack ts. */
export function toTs(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return String(value);
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`not a time: ${value}`);
  return String(parsed / 1000);
}

const toArchived = (row: MessageRow): ArchivedMessage => ({
  channel: row.channel,
  ts: String(row.ts),
  at: tsToIso(String(row.ts)),
  threadTs: row.thread_ts ? String(row.thread_ts) : null,
  userId: row.user_id,
  text: row.text,
});

/** Channel-level coverage is stored under this thread key; '' is not a ts. */
const CHANNEL_SCOPE = "";

export class SlackArchive {
  private readonly db: DatabaseSync;

  constructor(path = defaultChannelDbPath()) {
    this.db = openChannelDb(path, `
      CREATE TABLE IF NOT EXISTS slack_messages (
        channel TEXT NOT NULL,
        ts REAL NOT NULL,
        thread_ts REAL,
        user_id TEXT,
        text TEXT NOT NULL,
        PRIMARY KEY (channel, ts)
      );
      CREATE INDEX IF NOT EXISTS slack_messages_thread
        ON slack_messages (channel, thread_ts, ts);
      CREATE TABLE IF NOT EXISTS slack_sync (
        channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        oldest_ts REAL NOT NULL,
        newest_ts REAL NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (channel, thread_ts)
      );
    `);
  }

  /**
   * Store what Slack returned. An edit rewrites the row rather than adding
   * one, so the cache converges on the current text instead of keeping both.
   */
  put(channel: string, messages: SlackMessageEvent[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO slack_messages(channel, ts, thread_ts, user_id, text)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, ts) DO UPDATE SET
        thread_ts = excluded.thread_ts, user_id = excluded.user_id, text = excluded.text
    `);
    for (const msg of messages) {
      if (!msg.ts) continue; // malformed: nothing to key on
      stmt.run(
        channel,
        tsToNumber(msg.ts),
        msg.thread_ts ? tsToNumber(msg.thread_ts) : null,
        msg.user ?? msg.bot_id ?? null,
        msg.text ?? "",
      );
    }
  }

  /** Oldest first, which is how a transcript is read. */
  channelWindow(channel: string, since?: string, until?: string, limit = 200): ArchivedMessage[] {
    const rows = this.db.prepare(`
      SELECT channel, ts, thread_ts, user_id, text FROM slack_messages
      WHERE channel = ? AND ts >= ? AND ts <= ?
      ORDER BY ts ASC LIMIT ?
    `).all(
      channel,
      since ? tsToNumber(since) : 0,
      until ? tsToNumber(until) : Number.MAX_SAFE_INTEGER,
      limit,
    ) as unknown as MessageRow[];
    return rows.map(toArchived);
  }

  /**
   * A thread is its parent plus every reply. Slack marks replies with
   * `thread_ts`, but the parent's own `thread_ts` is only set once it has
   * replies — so the parent is matched on its `ts` as well.
   */
  thread(channel: string, threadTs: string): ArchivedMessage[] {
    const key = tsToNumber(threadTs);
    const rows = this.db.prepare(`
      SELECT channel, ts, thread_ts, user_id, text FROM slack_messages
      WHERE channel = ? AND (thread_ts = ? OR ts = ?)
      ORDER BY ts ASC
    `).all(channel, key, key) as unknown as MessageRow[];
    return rows.map(toArchived);
  }

  span(channel: string, threadTs = CHANNEL_SCOPE): SyncSpan | null {
    const row = this.db.prepare(`
      SELECT oldest_ts, newest_ts, synced_at FROM slack_sync
      WHERE channel = ? AND thread_ts = ?
    `).get(channel, threadTs) as
      | { oldest_ts: number; newest_ts: number; synced_at: number }
      | undefined;
    return row
      ? { oldestTs: String(row.oldest_ts), newestTs: String(row.newest_ts), syncedAt: row.synced_at }
      : null;
  }

  /**
   * Record that `[oldest, newest]` is now synced.
   *
   * The span is only widened when the new window touches the stored one. A
   * disjoint fetch leaves it alone: its messages stay cached (harmless, and
   * they may still be served once the gap is filled), but claiming the union
   * would assert coverage over a range nobody ever asked Slack for.
   */
  noteSync(channel: string, oldest: string, newest: string, threadTs = CHANNEL_SCOPE): void {
    const existing = this.span(channel, threadTs);
    let from = tsToNumber(oldest);
    let to = tsToNumber(newest);
    if (existing) {
      const had = { from: tsToNumber(existing.oldestTs), to: tsToNumber(existing.newestTs) };
      const touches = from <= had.to && to >= had.from;
      if (touches) {
        from = Math.min(from, had.from);
        to = Math.max(to, had.to);
      } else {
        // Keep the old span rather than inventing coverage across the gap.
        from = had.from;
        to = had.to;
      }
    }
    this.db.prepare(`
      INSERT INTO slack_sync(channel, thread_ts, oldest_ts, newest_ts, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, thread_ts) DO UPDATE SET
        oldest_ts = excluded.oldest_ts, newest_ts = excluded.newest_ts,
        synced_at = excluded.synced_at
    `).run(channel, threadTs, from, to, Date.now());
  }

  /** Is `[since, until]` inside what we have already synced? */
  covers(channel: string, since?: string, until?: string): boolean {
    const span = this.span(channel);
    if (!span || until === undefined) return false;
    const from = since ? tsToNumber(since) : 0;
    return from >= tsToNumber(span.oldestTs) && tsToNumber(until) <= tsToNumber(span.newestTs);
  }

  close(): void {
    this.db.close();
  }
}
