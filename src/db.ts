// The one connection, and the one place the schema is written down: one ordered
// list of migrations, applied in one transaction before any store exists.
// `user_version` is per database, not per table, so the schema cannot be
// spread across modules.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { logger } from "./log.js";
import { PIER_DB } from "./paths.js";

const log = logger("db");

/** Per kind, because full copies are large and a run of releases must not
 *  evict the pre-migration copies. */
const KEEP_BACKUPS = 3;

/** Two Pier processes on one PIER_HOME contend at boot, when both want to
 *  migrate; failing instantly turns a restart race into a crash loop. */
const BUSY_TIMEOUT_MS = 5_000;

/** Append-only, never edited: index + 1 is the `user_version` after that entry.
 *  Fix a mistake with the next one — somebody's database already ran the old one. */
const MIGRATIONS: readonly string[] = [
  // 1 — the 0.0.1 schema.
  `
  -- The single credential in front of every HTTP surface (web/auth.ts).
  CREATE TABLE auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Instance facts that are neither a credential nor per-session; one row per
  -- setting, so the next setting is not the next table.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Workbench bookkeeping: pinned = listed under Projects, unread = a turn
  -- finished that no client has acknowledged.
  CREATE TABLE session_state (
    session_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0
  );

  -- One document per platform: credentials, defaults, chats, bound users.
  CREATE TABLE channels (
    platform TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );

  -- Durable conversation → session routing for IM channels.
  CREATE TABLE conversations (
    channel_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, conversation_id)
  );

  -- Reaction receipts still to be cleared. message_id is TEXT: a Slack ts is
  -- 1761234567.123456, which no float holds exactly.
  CREATE TABLE receipts (
    platform TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (platform, chat_id, message_id)
  );

  -- Scheduled work. The row keeps its whole JSON document; the columns beside
  -- it are only what a query filters or orders by.
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    callback_state TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX task_runs_task_time ON task_runs(task_id, queued_at DESC);
  CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX task_messages_run_time ON task_messages(run_id, created_at);
  CREATE TABLE task_groups (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    callback_state TEXT,
    finished_at INTEGER,
    json TEXT NOT NULL
  );
  `,
  // 2 — provider credentials move from <agentDir>/auth.json into the database.
  `
  -- One row per provider (key = provider id), value sealed by secrets.ts.
  -- Owned by agent/credentials.ts.
  CREATE TABLE credentials (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 3 — what a restart's drain deadline cut off, told to the chat at next boot.
  `
  -- Written only when a graceful restart aborts a still-running turn; the next
  -- boot delivers each row and clears it once delivered. Owned by drain.ts.
  CREATE TABLE restart_ledger (
    id INTEGER PRIMARY KEY,
    channel_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 4 — Projects can render from SQLite without scanning every Pi transcript.
  `
  ALTER TABLE session_state ADD COLUMN cwd TEXT;
  ALTER TABLE session_state ADD COLUMN title TEXT;
  ALTER TABLE session_state ADD COLUMN created_at INTEGER;
  `,
  // 5 — the workbench can reach a browser that is not open (web/push.ts).
  `
  -- One row per browser that asked to be notified, exactly as the Push API
  -- described it; a dead endpoint is deleted when its service says so.
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- This instance's VAPID identity: one key pair, minted on first use. Every
  -- subscription above is bound to it, so it is never rotated on its own.
  CREATE TABLE push_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 6 — Projects keeps the order the workbench was put in, by hand.
  `
  -- Manual order, both nullable: a row nobody has dragged sorts on top of the
  -- list it belongs to, so a fresh database needs no backfill. sort places a
  -- session inside its project; project_sort places the project, carried on
  -- every one of its rows because a project is a cwd, not a table.
  ALTER TABLE session_state ADD COLUMN sort INTEGER;
  ALTER TABLE session_state ADD COLUMN project_sort INTEGER;
  `,
  // 7 — the session listing, so a transcript is read once (agent/listing.ts).
  `
  -- One row per session file. (size, mtime) is what makes the row usable
  -- without opening the file; parsed_bytes is where reading resumes when it
  -- grew, and is always a line boundary. Derived from disk and disposable: a
  -- deleted row costs one re-read, never a fact.
  CREATE TABLE session_index (
    path TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT,
    first_message TEXT,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    parsed_bytes INTEGER NOT NULL
  );
  `,
  // 8 — Projects holds a working set: what is warm, plus what is kept.
  `
  -- Membership was permanent, so every throwaway session stayed in the rail
  -- until someone removed it by hand. last_active is the lease: the end of a
  -- turn renews it, and web/session-state.ts stops listing a row that ran out.
  -- kept opts one row out of expiry entirely — what the pin control now means.
  ALTER TABLE session_state ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_active INTEGER;
  -- Left NULL on purpose: the honest value is when the transcript was last
  -- written, which only a listing knows. web/server.ts pays one for a database
  -- carrying rows without it, the same gate the pin backfill already uses, so
  -- the first rail after an upgrade is dated by use and not by creation.
  `,
  // 9 — the summary a transcript already carries is read, not mirrored.
  `
  -- Dropped rather than left unread: a column nobody writes still answers when
  -- somebody selects it, and the next reader has no way to tell a stale title
  -- from a current one. The pre-migration backup beside the database is the
  -- way back, not a row of fossils. cwd stays — it is the key a project's
  -- manual place is stamped on, and it never changes for a session.
  ALTER TABLE session_state DROP COLUMN title;
  ALTER TABLE session_state DROP COLUMN created_at;
  ALTER TABLE session_state DROP COLUMN last_active;
  `,
  // 10 — taking a session into Projects is itself an act, and it is dated.
  `
  -- When a hand last put this session in Projects (pin, or a keep toggle).
  -- Not the mirror migration 9 removed: last_active was a copy of a fact the
  -- transcript owns, while this one exists nowhere else — pinning a cold
  -- session back is a statement that it is warm again, and without a record of
  -- *when* it was made the row is dropped by the same read that drew it.
  -- NULL for every row that predates this: never pinned within a lease.
  ALTER TABLE session_state ADD COLUMN pinned_at INTEGER;
  `,
  // 11 — Projects holds what a hand put there, for as long as the hand says.
  `
  -- The lease is gone, so both of its columns are. It expired nothing: a row
  -- it dropped kept its transcript, its place and its ownership, and one more
  -- turn brought it back — so what it actually did was hide rows nobody asked
  -- it to hide, and kept existed only to opt out of that. On the instance this
  -- was decided on, the lease had never dropped a row: 20 pinned sessions,
  -- none past seven days, one kept. Removing a row from Projects is the ✓ on
  -- the row, and it stays the only way out.
  ALTER TABLE session_state DROP COLUMN kept;
  ALTER TABLE session_state DROP COLUMN pinned_at;
  `,
  // 12 — one row is how two processes take turns (src/tools.ts).
  `
  -- The tools sync, held across processes: the token says who holds it, the
  -- heartbeat says they are still alive. Both processes already open this
  -- database, and BEGIN IMMEDIATE is real mutual exclusion — a lock file with
  -- a pid in it is neither, which is what this replaces. One row, because
  -- there is one thing to serialize; the second lock can bring its own table
  -- and its own reason for existing.
  CREATE TABLE tools_sync_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  `,
  // 13 — a signed-in browser can be signed out on its own (web/auth.ts).
  `
  -- One row per signed-in browser. The cookie carries "<id>.<token>" and only
  -- the token's SHA-256 is stored, so a copy of this database cannot be turned
  -- into a session — and deleting a row is what revocation is. seen_at is the
  -- whole lifetime: the session ends one TTL after it, so there is no second
  -- column that can disagree about when.
  CREATE TABLE web_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    agent TEXT NOT NULL
  );
  `,
  // 14 — signing a browser out also stops notifying it (web/push.ts).
  `
  -- A subscription belongs to the web session that made it, and dies with it:
  -- the cascade is the rule, so no code has to remember to run it — revoking a
  -- session, changing the password and recovering it all reach here for free.
  -- Rebuilt rather than altered because a foreign key cannot be added to an
  -- existing table; nothing is carried over, since migration 13 invalidated
  -- every cookie and each of these rows belongs to a browser that is now
  -- signed out. A browser re-subscribes on its next load.
  DROP TABLE push_subscriptions;
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    session_id TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE
  );
  `,
  // 15 — the scheduler's tick stops reading the rows it cannot deliver.
  `
  -- Once a second, tasks/ asks for the runs whose callback is still owed and
  -- the messages whose injection has not landed. Both are a handful of rows
  -- filtered on one low-cardinality column, and without an index both are a
  -- full scan of a table that only grows — the sweep got slower with every
  -- run that finished cleanly and can never match again.
  CREATE INDEX task_runs_callback_state ON task_runs(callback_state);
  CREATE INDEX task_messages_state ON task_messages(state);
  `,
  // 16 — the same tick stops parsing every task document to find none due.
  `
  -- When a task is next due is the one field the scheduler asks about once a
  -- second, and it lived only inside the JSON: answering meant reading and
  -- parsing every definition, due or not. A generated column keeps the JSON
  -- as the only record while giving the query planner a value it can index; a
  -- disabled or archived task has no next run, so NULLs stay out of the index.
  ALTER TABLE tasks ADD COLUMN next_run_at INTEGER
    GENERATED ALWAYS AS (json_extract(json, '$.nextRunAt')) VIRTUAL;
  CREATE INDEX tasks_due ON tasks(next_run_at) WHERE next_run_at IS NOT NULL;
  `,
  // 17 — stable global pages, including sparse lists with unmatched probes hidden.
  `
  CREATE INDEX task_runs_time_id ON task_runs(queued_at DESC, id DESC);
  CREATE INDEX task_runs_visible_time ON task_runs(queued_at DESC, id DESC)
    WHERE NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0);
  `,
  // 18 — opening a session lists every run it delegated, not the last hour's.
  `
  -- The run cards are the messages a session sent, so the transcript wants
  -- all of them: the query is by the delegating session, which lived only in
  -- the JSON — without this every session open was a full scan of task_runs.
  CREATE INDEX task_runs_invoked_by ON task_runs(json_extract(json, '$.invokedBySessionId'), queued_at DESC);
  `,
  // 19 — the rail is one flat list, and pinned means "stuck to the top".
  `
  -- pinned used to mean "listed under Projects", and every session created in
  -- the workbench was. Now it means on top of the list, and nobody put a
  -- historical session there: kept as-is, every web session ever made would
  -- land in the pinned section. project_sort stays as a column nothing reads
  -- — a SQLite column drop rewrites the table for a NULL nobody pays for.
  UPDATE session_state SET pinned = 0;
  `,
  // 20 — the top of the rail is maintained, not arranged: no pin, no drag.
  `
  -- sort was the place a hand dragged a pinned row to; it is now the rank in
  -- the working set the rail keeps on top, which a session enters by being
  -- spoken to and leaves by being pushed out of the last slot. The pinned rows
  -- are that set's first members — they are what somebody was working on — in
  -- the order they were arranged in; never-dragged ones sorted first, so -1 is
  -- the rank that keeps them there.
  UPDATE session_state SET sort = -1 WHERE pinned = 1 AND sort IS NULL;
  UPDATE session_state SET sort = NULL WHERE pinned = 0;
  -- The set has a size (web/session-state.ts); more pins than that is a list
  -- the promotion rule would never have built.
  UPDATE session_state SET sort = NULL WHERE session_id IN (
    SELECT session_id FROM session_state WHERE sort IS NOT NULL
    ORDER BY sort, session_id LIMIT -1 OFFSET 8
  );
  ALTER TABLE session_state DROP COLUMN pinned;
  `,
  // 21 — unread is the workbench's own attention, so it is only its own rows.
  `
  -- The flag was written for every session whose turn ended, including the
  -- ones no browser is the reader of: an IM session answers its chat, a run's
  -- session answers its supervisor. Both are now skipped at the write
  -- (web/server.ts), and neither could ever be acked — that needs the session
  -- on screen — so the rows they left would stay set forever. On the instance
  -- this was decided on, 195 of 196 marks were those. Cleared wholesale rather
  -- than by owner: the one real row is a turn from before an upgrade nobody
  -- was watching for, and a false amber dot costs less than the join.
  UPDATE session_state SET unread = 0;
  `,
  // 22 — the palette finds what was said, not only what a session is called.
  `
  -- One row per user message and per assistant reply, keyed by the transcript
  -- it came from so a file that is rewritten or gone drops its rows in one
  -- statement (agent/listing.ts). Trigram tokens: a substring match with no
  -- word segmentation, which CJK text has none of and a path or an identifier
  -- in a prompt has too much of. Steps stay out — tool calls, their output,
  -- thinking are the bulk of a transcript and nobody searches for what ran.
  CREATE VIRTUAL TABLE session_fts USING fts5(
    text, session_id UNINDEXED, path UNINDEXED, role UNINDEXED, at UNINDEXED,
    tokenize = 'trigram'
  );
  -- Derived and disposable (migration 7): every row goes, so the next scan
  -- reads every transcript from its first byte and fills the table above.
  -- Resetting parsed_bytes alone would not — a row whose (size, mtime) still
  -- match is trusted without opening the file.
  DELETE FROM session_index;
  `,
];

/** `BEGIN IMMEDIATE`: taking the write lock up front turns a race with another
 *  Pier process into a wait, where deferred would be SQLITE_BUSY halfway through. */
export function transact<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Prepared statements memoized by SQL; callers hand it the same handful of
 *  strings forever. SQL built per call does not belong here: the cache is unbounded. */
export function statements(db: DatabaseSync): (sql: string) => StatementSync {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
    return stmt;
  };
}

let shared: DatabaseSync | undefined;

/** The process's one connection; a test passes `openDb(":memory:")` instead. */
export const pierDb = (): DatabaseSync => (shared ??= openDb(PIER_DB));

/** A restore point per release, schema migration or not. `version` is the Pier
 *  that produced the database: restoring one means reinstalling the code that
 *  speaks its schema, so the name carries that half of the pair. */
export function backupDb(version: string, path = PIER_DB): string | undefined {
  if (!existsSync(path)) return undefined;
  // In a filename, so no separator or traversal.
  const safe = version.replaceAll(/[^0-9A-Za-z.+-]/g, "_") || "unknown";
  const bak = join(backupsDir(path, true), `${basename(path)}.release-${safe}.bak`);
  copyDatabase(path, bak);
  log.info(`pre-update backup: ${bak}`);
  prune(releases(path));
  return bak;
}

/** `migrations` is injectable only so tests can exercise an upgrade. */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // Timeout first: two processes booting together contend on the WAL switch
  // itself, and journal_mode cannot change inside a transaction.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  // DatabaseSync is synchronous, so WAL's per-commit fsync would be the event
  // loop's wait. NORMAL survives a process crash; only power loss costs anything.
  db.exec("PRAGMA synchronous = NORMAL");
  // Off by default in SQLite; per connection, and a no-op inside a transaction.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, path, migrations);
  if (path !== ":memory:") restrict(path);
  return db;
}

/** Upgrades only: a database from a newer Pier is refused, since old code would
 *  write the new schema's tables and lose what it did not know about. */
function migrate(db: DatabaseSync, path: string, migrations: readonly string[]): void {
  const { user_version: at } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const target = migrations.length;
  if (at > target) {
    // Name the snapshot that exists: the operator is reading this because the
    // service will not start.
    const newest = path === ":memory:" ? undefined : snapshots(path)[0]?.file;
    throw new Error(
      `${path} is at schema ${at}, this Pier speaks ${target}: a database is ` +
        `never downgraded. Restore ${newest ?? `a copy from ${backupsDir(path)}`}, or run the newer Pier.`,
    );
  }
  // Version 0 with tables predates versioning; migration 1 assumes an empty file.
  if (at === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) {
    throw new Error(
      `${path} predates schema versioning and cannot be upgraded — nothing was changed. ` +
        `Move the file aside and restart; channel credentials, tasks and the password start over.`,
    );
  }
  if (at === target) return;
  // Statements and version number in one transaction: a version describing a
  // schema the database does not have is worse than a crash.
  db.exec("BEGIN IMMEDIATE");
  // Re-read inside the lock: the process that waited must not replay what the
  // winner already committed.
  const { user_version: locked } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (locked >= target) {
    db.exec("ROLLBACK");
    if (locked > target) {
      throw new Error(`${path} advanced to schema ${locked} while this Pier was waiting; it speaks ${target}`);
    }
    log.info(`schema already at ${locked}, migrated by another process`);
    return;
  }
  // Under the write lock: a read-only connection may VACUUM while this one
  // holds RESERVED, and other Pier starts wait instead of racing on the .tmp.
  if (locked > 0 && path !== ":memory:") {
    try {
      snapshot(path, locked);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  let step = locked;
  try {
    for (; step < target; step++) db.exec(migrations[step]!);
    db.exec(`PRAGMA user_version = ${target}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // Which one, and that the database is untouched: a bare SQLite error says neither.
    throw new Error(
      `migration ${step + 1} failed on ${path} — nothing was changed: ${String(err)}`,
      { cause: err },
    );
  }
  log.info(locked === 0 ? `schema created at version ${target}` : `schema ${locked} → ${target}`);
  if (path !== ":memory:") prune(snapshots(path).map(({ file }) => file));
}

/** The transaction protects against a migration that failed; this against one
 *  that succeeded and should not have. */
function snapshot(path: string, at: number): void {
  const bak = join(backupsDir(path, true), `${basename(path)}.v${at}.bak`);
  copyDatabase(path, bak);
  log.info(`pre-migration backup: ${bak}`);
}

/** `VACUUM INTO`, not `cp`: under WAL the committed tail lives in the `-wal`
 *  sidecar. Temp name plus rename, so a full disk leaves the old copy intact. */
function copyDatabase(path: string, bak: string): void {
  const tmp = `${bak}.tmp`;
  rmSync(tmp, { force: true }); // a previous crash may have left one
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  chmodSync(tmp, 0o600); // it holds everything the 0600 database holds
  renameSync(tmp, bak);
}

/** `db/backups/`, so the live file and its sidecars are never in the listing an
 *  operator prunes under pressure. `create` adopts copies an older Pier left
 *  beside the database. */
function backupsDir(path: string, create = false): string {
  const dir = join(dirname(path), "backups");
  if (!create) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = `${basename(path)}.`;
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || !name.endsWith(".bak")) continue;
    renameSync(join(dirname(path), name), join(dir, name));
    log.info(`moved ${name} into ${dir}`);
  }
  return dir;
}

/** `v<schema>` or `release-<version>`: disjoint prefixes, pruned per kind. */
function listBackups(path: string, kind: string): string[] {
  const dir = backupsDir(path);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(path)}.${kind}`;
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".bak"));
}

/** Pre-migration snapshots, newest schema first. */
function snapshots(path: string): { version: number; file: string }[] {
  const prefix = `${basename(path)}.v`;
  return listBackups(path, "v")
    .map((name) => ({
      version: Number(name.slice(prefix.length, -".bak".length)),
      file: join(backupsDir(path), name),
    }))
    .filter(({ version }) => Number.isInteger(version))
    .sort((a, b) => b.version - a.version);
}

/** Release restore points, newest first by mtime: ordering by the version in
 *  the name would mean reimplementing semver here. */
function releases(path: string): string[] {
  return listBackups(path, "release")
    .map((name) => join(backupsDir(path), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function prune(newestFirst: string[]): void {
  for (const file of newestFirst.slice(KEEP_BACKUPS)) {
    rmSync(file, { force: true });
    log.info(`removed superseded backup: ${file}`);
  }
}

/** The database holds the password hash; a 0644 `-wal` would leak what the
 *  0600 database hides. After the migration, so the sidecars exist by now. */
function restrict(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  chmodSync(dirname(path), 0o700);
  if (existsSync(backupsDir(path))) chmodSync(backupsDir(path), 0o700);
}
