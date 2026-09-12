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
  -- The single credential in front of every HTTP surface.
  CREATE TABLE auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Instance facts that are neither a credential nor per-session.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Workbench bookkeeping; unread = a turn finished that no client acknowledged.
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

  -- Scheduled work: the JSON is the document, the columns beside it are only
  -- what a query filters or orders by.
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
  // 2 — provider credentials.
  `
  -- One row per provider (key = provider id), value sealed by secrets.ts.
  CREATE TABLE credentials (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 3 — what a restart's drain deadline cut off, told to the chat at next boot.
  `
  -- Turns a graceful restart cut off; each row is delivered at next boot, then cleared.
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
  // 5 — Web Push.
  `
  -- One row per browser that asked to be notified, as the Push API described it.
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- This instance's VAPID key pair; every subscription is bound to it, so it
  -- is never rotated on its own.
  CREATE TABLE push_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 6 — manual order in the rail.
  `
  -- NULL sorts on top, so a fresh database needs no backfill.
  ALTER TABLE session_state ADD COLUMN sort INTEGER;
  ALTER TABLE session_state ADD COLUMN project_sort INTEGER;
  `,
  // 7 — the session listing, so a transcript is read once.
  `
  -- One row per session file, derived from disk and disposable. A row whose
  -- (size, mtime) match is trusted unopened; parsed_bytes is where reading resumes, always a line boundary.
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
  // 8 — working-set lease columns (dropped again in 9 and 11).
  `
  ALTER TABLE session_state ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_active INTEGER;
  `,
  // 9 — drop the columns that mirrored the transcript.
  `
  ALTER TABLE session_state DROP COLUMN title;
  ALTER TABLE session_state DROP COLUMN created_at;
  ALTER TABLE session_state DROP COLUMN last_active;
  `,
  // 10 — pinned_at (dropped again in 11).
  `
  ALTER TABLE session_state ADD COLUMN pinned_at INTEGER;
  `,
  // 11 — the lease is gone, so both of its columns are.
  `
  ALTER TABLE session_state DROP COLUMN kept;
  ALTER TABLE session_state DROP COLUMN pinned_at;
  `,
  // 12 — the cross-process tools sync lock.
  `
  -- One row: token says who holds the lock, heartbeat_at says they are still alive.
  CREATE TABLE tools_sync_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  `,
  // 13 — web sessions.
  `
  -- One row per signed-in browser; only the cookie token's SHA-256 is stored,
  -- deleting a row is revocation, and the session ends one TTL after seen_at.
  CREATE TABLE web_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    agent TEXT NOT NULL
  );
  `,
  // 14 — a push subscription belongs to the web session that made it.
  `
  -- Rebuilt: a foreign key cannot be added to an existing table.
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
  // 15 — indexes for the scheduler's once-a-second sweep.
  `
  CREATE INDEX task_runs_callback_state ON task_runs(callback_state);
  CREATE INDEX task_messages_state ON task_messages(state);
  `,
  // 16 — an indexable next-due value, with the JSON still the only record.
  `
  -- A disabled or archived task has no next run, so NULLs stay out of the index.
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
  // 18 — runs by delegating session.
  `
  CREATE INDEX task_runs_invoked_by ON task_runs(json_extract(json, '$.invokedBySessionId'), queued_at DESC);
  `,
  // 19 — pinned now means "stuck to the top"; nobody put a historical session there.
  `
  UPDATE session_state SET pinned = 0;
  `,
  // 20 — sort becomes the rank in the working set the rail keeps on top; pinned goes.
  `
  -- Pinned rows seed the set at rank -1, capped at the set's size (8).
  UPDATE session_state SET sort = -1 WHERE pinned = 1 AND sort IS NULL;
  UPDATE session_state SET sort = NULL WHERE pinned = 0;
  UPDATE session_state SET sort = NULL WHERE session_id IN (
    SELECT session_id FROM session_state WHERE sort IS NOT NULL
    ORDER BY sort, session_id LIMIT -1 OFFSET 8
  );
  ALTER TABLE session_state DROP COLUMN pinned;
  `,
  // 21 — unread is only written for web sessions now; clear the marks nobody could ack.
  `
  UPDATE session_state SET unread = 0;
  `,
  // 22 — message search.
  `
  -- One row per user message and assistant reply, keyed by transcript path.
  -- Trigram: substring match with no word segmentation, which CJK text has none of.
  CREATE VIRTUAL TABLE session_fts USING fts5(
    text, session_id UNINDEXED, path UNINDEXED, role UNINDEXED, at UNINDEXED,
    tokenize = 'trigram'
  );
  -- Every row goes so the next scan re-reads each transcript and fills the table above.
  DELETE FROM session_index;
  `,
  // 23 — the vault: named secrets `pier vault run` injects into one command.
  `
  -- name is an env-var name (^[A-Z][A-Z0-9_]{0,63}$). value is a sealed
  -- envelope (auto) or a vt:// record (approve): the shape is the level.
  CREATE TABLE vault (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 24 — channel credentials move into the vault under fixed names (channels/config.ts).
  `
  -- The blob moves verbatim: same DEK, no decrypt, so this runs locked like
  -- every migration. A name filed in the vault first wins (DO NOTHING); the
  -- channel copy is dropped either way.
  WITH moved(platform, path, name) AS (VALUES
    ('slack', '$.token', 'SLACK_TOKEN'), ('slack', '$.appToken', 'SLACK_APP_TOKEN'),
    ('lark', '$.token', 'LARK_APP_ID'), ('lark', '$.appToken', 'LARK_APP_SECRET'))
  INSERT INTO vault(name, value, updated_at)
    SELECT moved.name, json_extract(channels.json, moved.path), CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM moved JOIN channels ON channels.platform = moved.platform
    WHERE json_extract(channels.json, moved.path) <> ''
    ON CONFLICT(name) DO NOTHING;
  UPDATE channels SET json = json_remove(json, '$.token', '$.appToken');
  `,
  // 25 — the mid-run decision channel is gone; a control message is steer or follow_up.
  `DELETE FROM task_messages WHERE json_extract(json, '$.kind') IN ('progress', 'decision', 'reply');`,
  // 26 — a session created from the panel is re-created from its own launch record.
  `
  -- What the thread's session was created with, and the model/reasoning set on
  -- it since. Consulted only when Pi has no transcript to resume: a session
  -- never prompted was never written, and is re-created from this instead of
  -- from the chat defaults. NULL for a session launched from those defaults.
  ALTER TABLE conversations ADD COLUMN launch TEXT;
  -- The session → thread direction: channelOf / keyOf.
  CREATE INDEX conversations_session ON conversations(session_id);
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
