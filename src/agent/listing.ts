// Which sessions exist on disk, and what to call them — without reading a
// transcript that has not changed since the last scan.
//
// Pi's SessionManager.listAll() parses every line of every session file to
// answer that: ~250ms for 84 sessions of 30MB here, growing with the total
// bytes ever written rather than with the number of sessions. Every surface
// asks (the rail, Activity, a task lookup, every reconnect), so the scan sits
// on the interactive path and gets slower for the life of the instance. But a
// transcript is append-only and the facts a listing needs are all derived from
// bytes already read, so each byte is read once: rows live in pier.db, keyed by
// path and validated by (size, mtime), and a file that grew is picked up at the
// byte the last scan stopped on.
//
// Reading Pi's on-disk entries is the cost of that; agent/ is where the
// knowledge of Pi's formats already lives, and Pi's own reader is not
// incremental.

import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { pierDb, statements, transact } from "../db.js";
import { SESSION_TITLE_MAX } from "../limits.js";
import { logger } from "../log.js";
import { defaultAgentDir } from "./config.js";
import { textOf, type PiMessage } from "./events.js";

const log = logger("agent");

/** What a listing knows about a session — the subset of Pi's SessionInfo that
 *  Pier reads. Nothing else is derived, so nothing else can go stale. */
export interface SessionRecord {
  id: string;
  path: string;
  cwd: string;
  /** Session header timestamp, ms. */
  created: number;
  /** File mtime, ms; the listing is ordered by it, newest first. */
  modified: number;
  title?: string;
}

/** The seam pi.ts holds, so a test can hand it a listing instead of a disk. */
export interface SessionListing {
  scan(): Promise<SessionRecord[]>;
  /** Only a listing that shadows another parser has anything to audit. */
  audit?(native: () => Promise<NativeInfo[]>): Promise<number>;
}

/** What Pi's own reader answers, as far as a cross-check reads it. Declared
 *  here rather than imported: this file must not see the SDK. */
export interface NativeInfo {
  id: string;
  cwd: string;
  created: Date;
  name?: string | undefined;
  firstMessage?: string | undefined;
}

/** How many of the newest sessions a cross-check reads: enough that a format
 *  change surfaces within a boot or two, few enough to cost nothing. */
const AUDIT_SAMPLE = 5;

/** What one file contributes, folded entry by entry. `at` is how many bytes of
 *  it produced this — a partial trailing line is left for the next scan. */
interface Parsed {
  id: string;
  cwd: string;
  created: number;
  /** The name a session was given; the latest one wins, clears included. */
  name?: string;
  /** Its first user message, already clipped to a title. */
  first?: string;
  at: number;
}

interface IndexRow {
  path: string;
  id: string;
  cwd: string;
  created_at: number;
  name: string | null;
  first_message: string | null;
  size: number;
  mtime: number;
  parsed_bytes: number;
}

/** The name a session was given, else its first message. Two arguments rather
 *  than a row, because the stored row and the parsed one spell the second one
 *  differently and an object would silently accept either. */
const titleOf = (name?: string | null, first?: string | null): string | undefined =>
  name || first || undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * One entry folded into what a listing needs. Three answers, not two:
 * `undefined` is "no header yet" (blank and unparseable lines before it are
 * skipped, as Pi's own reader does), `null` is "not a session file" — a first
 * entry that is not a session header — and anything else is the state so far.
 */
function fold(acc: Parsed | undefined, line: string): Parsed | undefined | null {
  // The bulk of a transcript is message entries, each longer than this file.
  // Once the first user message is in hand only a rename still matters, and a
  // substring test costs a fraction of parsing one of them.
  if (acc?.first && !line.includes('"session_info"')) return acc;
  let entry: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object") entry = value as Record<string, unknown>;
  } catch {
    return acc ?? undefined;
  }
  if (!acc) {
    if (!entry) return undefined;
    const id = str(entry.id);
    const timestamp = str(entry.timestamp);
    if (entry.type !== "session" || !id || !timestamp) return null;
    return { id, cwd: str(entry.cwd) ?? "", created: Date.parse(timestamp), at: 0 };
  }
  if (entry?.type === "session_info") return { ...acc, name: str(entry.name)?.trim() || undefined };
  if (entry?.type === "message" && !acc.first) {
    const message = entry.message as PiMessage | undefined;
    if (message?.role !== "user") return acc;
    const text = textOf(message.content).trim();
    return text ? { ...acc, first: text.slice(0, SESSION_TITLE_MAX) } : acc;
  }
  return acc;
}

/** The listing Pier runs on: Pi's session directory, remembered in pier.db. */
export class IndexedListing implements SessionListing {
  #db?: DatabaseSync;
  #statements?: (sql: string) => StatementSync;

  constructor(
    private readonly dir: string = join(defaultAgentDir(), "sessions"),
    db?: DatabaseSync,
  ) {
    this.#db = db;
  }

  /** Opened on the first scan rather than in the constructor: building an
   *  agent factory must not open the instance database — tests build bare ones
   *  and never list. */
  #store(): DatabaseSync {
    return (this.#db ??= pierDb());
  }

  /** The scan's three statements, compiled on the first scan and not again. */
  #sql(): (sql: string) => StatementSync {
    return (this.#statements ??= statements(this.#store()));
  }

  async scan(): Promise<SessionRecord[]> {
    const known = new Map(
      (this.#sql()("SELECT * FROM session_index").all() as unknown as IndexRow[]).map((
        row,
      ) => [row.path, row]),
    );
    const records: SessionRecord[] = [];
    const write: IndexRow[] = [];
    for (const file of await this.#files()) {
      const row = known.get(file.path);
      known.delete(file.path); // what is left over is no longer on disk
      if (row && row.size === file.size && row.mtime === file.modified) {
        const title = titleOf(row.name, row.first_message);
        records.push({
          id: row.id,
          path: row.path,
          cwd: row.cwd,
          created: row.created_at,
          modified: row.mtime,
          ...(title ? { title } : {}),
        });
        continue;
      }
      // Only a file that *grew* can be resumed mid-way. Anything else is read
      // whole — new, truncated, or rewritten. Rewritten includes the same
      // length with a different mtime, which resuming would answer with the
      // old derived data stamped with the new mtime: a row that then matches on
      // every later scan and is never corrected.
      const parsed = await this.#read(
        file.path,
        row && file.size > row.size
          ? {
            id: row.id,
            cwd: row.cwd,
            created: row.created_at,
            ...(row.name === null ? {} : { name: row.name }),
            ...(row.first_message === null ? {} : { first: row.first_message }),
            at: row.parsed_bytes,
          }
          : undefined,
      );
      if (!parsed) continue; // not a session file, or unreadable
      write.push({
        path: file.path,
        id: parsed.id,
        cwd: parsed.cwd,
        created_at: parsed.created,
        name: parsed.name ?? null,
        first_message: parsed.first ?? null,
        size: file.size,
        mtime: file.modified,
        parsed_bytes: parsed.at,
      });
      const title = titleOf(parsed.name, parsed.first);
      records.push({
        id: parsed.id,
        path: file.path,
        cwd: parsed.cwd,
        created: parsed.created,
        modified: file.modified,
        ...(title ? { title } : {}),
      });
    }
    this.#save(write, [...known.keys()]);
    return records.sort((a, b) => b.modified - a.modified);
  }

  /**
   * The reason this file is allowed to exist: it parses Pi's transcripts
   * itself, and nothing but a comparison keeps it honest when that format
   * moves. Reads the newest few both ways; a disagreement is logged with both
   * answers and the index row is dropped, so the next scan reads that file
   * whole rather than trusting what this one derived. Returns how many
   * disagreed — off the interactive path, never blocking a boot.
   */
  async audit(native: () => Promise<NativeInfo[]>): Promise<number> {
    const sample = (await this.scan()).slice(0, AUDIT_SAMPLE);
    if (!sample.length) return 0;
    const theirs = new Map((await native()).map((info) => [info.id, info]));
    const stale: string[] = [];
    for (const mine of sample) {
      const info = theirs.get(mine.id);
      const seen = { cwd: mine.cwd, created: mine.created, title: mine.title };
      const want = info && {
        cwd: info.cwd,
        created: info.created.getTime(),
        title: info.name ?? info.firstMessage?.slice(0, SESSION_TITLE_MAX),
      };
      if (want && want.cwd === seen.cwd && want.created === seen.created &&
        want.title === seen.title) continue;
      log.warn(`session index disagrees with Pi about ${mine.id}: index ${
        JSON.stringify(seen)
      }, Pi ${JSON.stringify(want ?? "no such session")} — dropping ${mine.path}`);
      stale.push(mine.path);
    }
    this.#save([], stale);
    return stale.length;
  }

  /** Every session file with its size and mtime — the only syscalls a scan
   *  where nothing changed makes. */
  async #files(): Promise<{ path: string; size: number; modified: number }[]> {
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink());
    const found = await Promise.all(dirs.map(async (dir) => {
      const at = join(this.dir, dir.name);
      const names = await fs.readdir(at).catch(() => [] as string[]);
      return Promise.all(names.filter((n) => n.endsWith(".jsonl")).map(async (name) => {
        const path = join(at, name);
        const stat = await fs.stat(path).catch(() => null);
        return stat?.isFile()
          ? { path, size: stat.size, modified: Math.round(stat.mtimeMs) }
          : null;
      }));
    }));
    return found.flat().filter((f): f is { path: string; size: number; modified: number } => !!f);
  }

  /** From `from.at`, or from the start when there is nothing to resume. */
  async #read(path: string, from?: Parsed): Promise<Parsed | null> {
    let acc = from;
    let at = from?.at ?? 0;
    let buffer = "";
    try {
      for await (const chunk of createReadStream(path, { encoding: "utf8", start: at })) {
        buffer += chunk as string;
        for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          at += Buffer.byteLength(line) + 1;
          const next = fold(acc, line);
          if (next === null) return null;
          acc = next;
        }
      }
    } catch (err) {
      // A file that cannot be read is left out of this listing and out of the
      // index, so the next scan tries it again rather than remembering a gap.
      log.warn(`session file ${path} could not be read`, err);
      return null;
    }
    return acc ? { ...acc, at } : null;
  }

  /** One transaction, after all reading: a half-written index would hand the
   *  next scan a size it never parsed to. */
  #save(rows: IndexRow[], gone: string[]): void {
    if (!rows.length && !gone.length) return;
    const db = this.#store();
    const sql = this.#sql();
    const upsert = sql(
      `INSERT INTO session_index(path, id, cwd, created_at, name, first_message, size, mtime, parsed_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         id = excluded.id, cwd = excluded.cwd, created_at = excluded.created_at,
         name = excluded.name, first_message = excluded.first_message,
         size = excluded.size, mtime = excluded.mtime,
         parsed_bytes = excluded.parsed_bytes`,
    );
    const drop = sql("DELETE FROM session_index WHERE path = ?");
    transact(db, () => {
      for (const r of rows) {
        upsert.run(
          r.path,
          r.id,
          r.cwd,
          r.created_at,
          r.name,
          r.first_message,
          r.size,
          r.mtime,
          r.parsed_bytes,
        );
      }
      for (const path of gone) drop.run(path);
    });
  }
}
