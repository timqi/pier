// Which sessions exist on disk and what to call them, reading each transcript
// byte once: Pi's own listing parses every file whole (~250ms for 30MB) and
// every surface asks. Rows live in pier.db keyed by path and validated by
// (size, mtime); a file that grew resumes where the last scan stopped. The same
// pass indexes what was said into `session_fts` for the palette.

import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SearchHit } from "../core/types.js";
import { pierDb, statements, transact } from "../db.js";
import { SESSION_TITLE_MAX } from "../core/types.js";
import { logger } from "../log.js";
import { defaultAgentDir } from "./config.js";
import { hasToolCalls, textOf, type PiMessage } from "./events.js";

const log = logger("agent");

/** The subset of Pi's SessionInfo that Pier reads. */
export interface SessionRecord {
  id: string;
  path: string;
  cwd: string;
  /** Session header timestamp, ms. */
  created: number;
  /** File mtime, ms. */
  modified: number;
  title?: string;
}

/** The seam pi.ts holds, so a test can hand it a listing instead of a disk. */
export interface SessionListing {
  scan(): Promise<SessionRecord[]>;
  audit?(native: () => Promise<NativeInfo[]>): Promise<number>;
  search?(query: string, limit?: number): SearchHit[];
}

/** Declared rather than imported: this file must not see the SDK. */
export interface NativeInfo {
  id: string;
  cwd: string;
  created: Date;
  name?: string | undefined;
  firstMessage?: string | undefined;
}

/** Enough that a format change surfaces within a boot or two. */
const AUDIT_SAMPLE = 5;

interface Said {
  role: "user" | "assistant";
  /** The message's own stamp, ms. */
  at: number;
  text: string;
}

/** `at` is how many bytes produced this; a partial trailing line waits for the next scan. */
interface Parsed {
  id: string;
  cwd: string;
  created: number;
  /** The latest name wins, clears included. */
  name?: string;
  /** Already clipped to a title. */
  first?: string;
  /** Said in the bytes *this* read covered; a resumed read appends. */
  said: Said[];
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

interface Written extends IndexRow {
  said: Said[];
  /** The read started at byte 0. */
  whole: boolean;
}

const titleOf = (name?: string | null, first?: string | null): string | undefined =>
  name || first || undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A reply that calls a tool is a step, not a reply (events.ts), and steps are
 *  not indexed. `clean` takes off the speaker header (core/identity.ts), which
 *  as text would make "operator" hit every session. */
function saidIn(
  message: PiMessage | undefined,
  entryAt: string | undefined,
  clean: (text: string) => string,
): Said | undefined {
  if (message?.role !== "user" && message?.role !== "assistant") return undefined;
  if (message.role === "assistant" && hasToolCalls(message)) return undefined;
  const text = clean(textOf(message.content)).trim();
  if (!text) return undefined;
  const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entryAt ?? "");
  return { role: message.role, at: Number.isFinite(at) ? at : 0, text };
}

/** `undefined` is "no header yet" (leading junk is skipped, as Pi's reader
 *  does), `null` is "not a session file". */
function fold(
  acc: Parsed | undefined,
  line: string,
  clean: (text: string) => string,
): Parsed | undefined | null {
  // The bulk of a transcript is tool results; two substring tests cost a
  // fraction of parsing one.
  if (acc && !line.includes('"message"') && !line.includes('"session_info"')) return acc;
  let entry: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object") entry = value as Record<string, unknown>;
  } catch {
    // The tail of a transcript Pi is still appending to; the next scan reads it whole.
    return acc ?? undefined;
  }
  if (!acc) {
    if (!entry) return undefined;
    const id = str(entry.id);
    const timestamp = str(entry.timestamp);
    if (entry.type !== "session" || !id || !timestamp) return null;
    return { id, cwd: str(entry.cwd) ?? "", created: Date.parse(timestamp), said: [], at: 0 };
  }
  if (entry?.type === "session_info") return { ...acc, name: str(entry.name)?.trim() || undefined };
  if (entry?.type === "message") {
    const message = entry.message as PiMessage | undefined;
    const said = saidIn(message, str(entry.timestamp), clean);
    if (!said) return acc;
    acc.said.push(said);
    // The title keeps the header the index drops; surfaces read it back
    // through core/identity.ts.
    if (acc.first || said.role !== "user") return acc;
    return { ...acc, first: textOf(message?.content).trim().slice(0, SESSION_TITLE_MAX) };
  }
  return acc;
}

/** A picker, not a results page. */
const SEARCH_LIMIT = 8;

/** A trigram token is one character, so `snippet()` is asked for its ceiling
 *  of 64 tokens; the default 12 fits one word. */
const SNIPPET_CHARS = 64;

/** Whitespace splits a query: a space is "and this too", not a character to
 *  find. A term is quoted where it has to be, so a phrase is still findable. */
const termsOf = (query: string): string[] => query.split(/\s+/).filter(Boolean);

/** Delimited like `snippet()` (\u0001 … \u0002, `…` for a cut), so a surface
 *  draws one shape for both paths. Every term is marked where it first
 *  appears inside the window, as `snippet()` marks every phrase it kept.
 *  ASCII case folding: LIKE found the row by the same rule. */
function around(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const found = terms
    .map((term) => ({ at: lower.indexOf(term.toLowerCase()), length: term.length }))
    .filter((mark) => mark.at >= 0)
    .sort((a, b) => a.at - b.at);
  const first = found[0];
  if (!first) return text.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, first.at - SNIPPET_CHARS / 2);
  const end = Math.min(text.length, first.at + first.length + SNIPPET_CHARS / 2);
  let out = start ? "…" : "";
  let at = start;
  for (const mark of found) {
    // Terms that overlap one another, or reach past the window, mark once.
    if (mark.at < at || mark.at + mark.length > end) continue;
    out += `${text.slice(at, mark.at)}\u0001${text.slice(mark.at, mark.at + mark.length)}\u0002`;
    at = mark.at + mark.length;
  }
  return `${out}${text.slice(at, end)}${end < text.length ? "…" : ""}`;
}

interface FtsRow {
  session_id: string;
  role: "user" | "assistant";
  at: number;
  /** From `snippet()` on the MATCH path; the LIKE path carries `text` instead. */
  snippet?: string;
  text?: string;
}

export class IndexedListing implements SessionListing {
  #db?: DatabaseSync;
  #statements?: (sql: string) => StatementSync;

  constructor(
    private readonly dir: string = join(defaultAgentDir(), "sessions"),
    db?: DatabaseSync,
    /** Handed in rather than imported: the header rule is core's, and agent/
     *  does not import core at runtime. */
    private readonly clean: (text: string) => string = (text) => text,
  ) {
    this.#db = db;
  }

  /** Opened on the first scan: building a factory must not open the database. */
  #store(): DatabaseSync {
    return (this.#db ??= pierDb());
  }

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
    const write: Written[] = [];
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
      // Only a file that grew can be resumed. Same length with a new mtime is
      // rewritten, and resuming would stamp old data with the new mtime forever.
      const resumed = row !== undefined && file.size > row.size;
      const parsed = await this.#read(
        file.path,
        resumed
          ? {
            id: row.id,
            cwd: row.cwd,
            created: row.created_at,
            ...(row.name === null ? {} : { name: row.name }),
            ...(row.first_message === null ? {} : { first: row.first_message }),
            said: [],
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
        said: parsed.said,
        whole: !resumed,
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

  /** This file parses Pi's transcripts itself, and only a comparison keeps it
   *  honest when the format moves. A disagreement drops the index row, so the
   *  next scan reads that file whole. */
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

  /** Every term must appear, in any order, anywhere in the one message. Under
   *  three code points the trigram tokenizer has nothing to match, and a
   *  two-character term is what a CJK word often is: substring scan instead —
   *  one short term puts the whole query on that path. */
  search(query: string, limit = SEARCH_LIMIT): SearchHit[] {
    const sql = this.#sql();
    const terms = termsOf(query);
    if (!terms.length) return [];
    const rows = terms.every((term) => [...term].length >= 3)
      // Quoted: a term is a string to find, never FTS syntax.
      ? sql(
        `SELECT session_id, role, at, snippet(session_fts, 0, char(1), char(2), '…', ${SNIPPET_CHARS}) AS snippet
         FROM session_fts WHERE text MATCH ? ORDER BY bm25(session_fts), at DESC`,
      ).iterate(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "))
      : sql(
        `SELECT session_id, role, at, text FROM session_fts WHERE ${
          terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ")
        } ORDER BY at DESC`,
      ).iterate(...terms.map((term) => `%${term.replaceAll(/[\\%_]/g, "\\$&")}%`));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    // Walked, not fetched: a chatty session has hundreds of rows for one hit.
    for (const row of rows as Iterable<FtsRow>) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      hits.push({
        sessionId: row.session_id,
        role: row.role,
        at: row.at,
        snippet: row.snippet ?? around(row.text ?? "", terms),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

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
          const next = fold(acc, line, this.clean);
          if (next === null) return null;
          acc = next;
        }
      }
    } catch (err) {
      // Left out of the index too, so the next scan tries it again.
      log.warn(`session file ${path} could not be read`, err);
      return null;
    }
    return acc ? { ...acc, at } : null;
  }

  /** One transaction after all reading: a half-written index would hand the
   *  next scan a size it never parsed to. A whole read replaces what the file
   *  had said; a resumed read only adds. */
  #save(rows: Written[], gone: string[]): void {
    if (!rows.length && !gone.length) return;
    const db = this.#store();
    const sql = this.#sql();
    const forget = sql("DELETE FROM session_fts WHERE path = ?");
    const say = sql("INSERT INTO session_fts(text, session_id, path, role, at) VALUES (?, ?, ?, ?, ?)");
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
        if (r.whole) forget.run(r.path);
        for (const s of r.said) say.run(s.text, r.id, r.path, s.role, s.at);
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
      for (const path of gone) {
        drop.run(path);
        forget.run(path);
      }
    });
  }
}
