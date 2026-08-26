// The one connection, and the one place the schema is written down.
//
// Every store used to open `pier.db` for itself and create its own tables with
// `CREATE TABLE IF NOT EXISTS`. That works exactly once: it can add a table but
// never change one, so the first column an upgrade needed would have left every
// existing instance with a schema nothing could repair. `user_version` is a
// single number per *database*, not per table, which is why the schema cannot
// stay spread across five modules — and five connections to one file is also
// five writers competing for the same lock.
//
// So: one connection, one ordered list of migrations, applied in one
// transaction before any store exists. A store receives the handle and owns
// only its queries.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./log.js";
import { PIER_DB } from "./paths.js";

const log = logger("db");

/** Snapshots to keep *of each kind*. Three is two upgrades of regret plus one:
 *  they are full copies of the database, and the one that matters is the
 *  newest. Counted per kind because the two kinds answer different questions —
 *  a run of releases must not evict the pre-migration copies. */
const KEEP_BACKUPS = 3;

/** How long a second process may wait for the write lock before failing. Two
 *  Pier processes on one PIER_HOME contend exactly once — at boot, when both
 *  want to migrate — and failing instantly there turns a restart race into a
 *  crash loop. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Append-only, never edited: index + 1 is the `user_version` a database is at
 * once that entry has run. An entry that shipped is history — fix a mistake
 * with the next one, because somebody's database already ran the old one.
 *
 * Migration 1 is the whole schema as of 0.0.1 and assumes nothing before it:
 * pre-release databases are not upgraded, they are deleted.
 */
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
  // 7 — sessions can share state and events without sharing a transcript.
  `
  -- Append-only event log read two ways: latest(topic, key) is shared memory,
  -- log(topic, after) is a message stream. Rows are immutable — a change is a
  -- new event, a deletion is a tombstone. Owned by bus/store.ts.
  CREATE TABLE bus_events (
    id TEXT PRIMARY KEY,              -- ULID: lexicographic order is time order
    topic TEXT NOT NULL,              -- 'a/b/c' hierarchy
    key TEXT,                         -- NULL = plain event; set = latest() semantics
    kind TEXT NOT NULL DEFAULT 'event',  -- 'event' | 'fact' | 'tombstone'
    payload TEXT NOT NULL,            -- small JSON; large content goes to file_ptr
    file_ptr TEXT,
    scope TEXT NOT NULL,              -- 'run:<rootRunId>' | 'project:<cwd>' | 'instance'
    writer_session TEXT NOT NULL,
    caused_by TEXT,                   -- event id that triggered this write (storm guard)
    hops INTEGER NOT NULL DEFAULT 0,
    ttl_seconds INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX bus_events_topic ON bus_events(topic, id);
  CREATE INDEX bus_events_latest ON bus_events(topic, key, id) WHERE key IS NOT NULL;
  `,
  // 8 — a write can reach its readers instead of waiting to be polled.
  `
  -- Who hears about a bus write: one row per (session, pattern). scopes is the
  -- set pinned at subscribe time — a cursor is just an id, so a scope set that
  -- grew mid-stream would silently skip the new scope's history. Owned by
  -- bus/subs.ts.
  CREATE TABLE bus_subs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic_glob TEXT NOT NULL,
    mode TEXT NOT NULL,               -- 'steer' | 'queue' | 'wake'
    scopes TEXT NOT NULL,             -- JSON array, pinned at subscribe
    cursor TEXT NOT NULL DEFAULT '',  -- last event id the subscriber acked
    created_at TEXT NOT NULL,
    UNIQUE(session_id, topic_glob)
  );

  -- Pointer notifications still owed, one open row per subscription at most —
  -- the row is the coalescing. Columns beside the JSON document are only what
  -- the delivery sweep filters on (the task_runs pattern).
  CREATE TABLE bus_notes (
    id TEXT PRIMARY KEY,
    sub_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT,
    next_attempt_at INTEGER,
    json TEXT NOT NULL
  );
  CREATE INDEX bus_notes_session ON bus_notes(session_id, state);
  `,
];

let shared: DatabaseSync | undefined;

/**
 * The process's one connection, opened and migrated on first use. Every store
 * defaults to it; a test passes `openDb(":memory:")` instead.
 */
export const pierDb = (): DatabaseSync => (shared ??= openDb(PIER_DB));

/** A release-level restore point, taken while the service is stopped even when
 * the release has no schema migration. The previous complete copies stay put if
 * writing this one fails.
 *
 * `version` is the Pier that produced this database, not the one being
 * installed: the updater runs this from the tree it is about to replace, and
 * restoring a database means reinstalling the code that speaks its schema
 * (`migrate` refuses one from a newer Pier). So the name carries the other half
 * of the pair. Backing up twice at one version replaces that version's copy —
 * the pairing is identical, so a second name for it would say nothing. */
export function backupDb(version: string, path = PIER_DB): string | undefined {
  if (!existsSync(path)) return undefined;
  // In a filename, so it may not carry a separator or a traversal; a version
  // this malformed is a broken install, not something to guess at.
  const safe = version.replaceAll(/[^0-9A-Za-z.+-]/g, "_") || "unknown";
  const bak = join(backupsDir(path, true), `${basename(path)}.release-${safe}.bak`);
  copyDatabase(path, bak);
  log.info(`pre-update backup: ${bak}`);
  prune(releases(path));
  return bak;
}

/** Open a database, bring it to the current schema, and lock down its files.
 *  `migrations` is injectable only so tests can exercise an upgrade — there is
 *  exactly one real list. */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // Timeout first: two processes booting together contend on the WAL switch
  // itself. Outside the transaction below: journal_mode is a property of the
  // file, and SQLite refuses to change it inside one.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db, path, migrations);
  if (path !== ":memory:") restrict(path);
  return db;
}

/**
 * Upgrades only. `user_version` counts up and nothing counts it back down, so a
 * database from a newer Pier is refused rather than served: the old code would
 * happily write the new schema's tables and lose whatever it did not know
 * about. The way back is the `.bak` this function writes before upgrading.
 */
function migrate(db: DatabaseSync, path: string, migrations: readonly string[]): void {
  const { user_version: at } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const target = migrations.length;
  if (at > target) {
    // Name the snapshot that exists rather than a pattern: the operator is
    // reading this because the service will not start.
    const newest = path === ":memory:" ? undefined : snapshots(path)[0]?.file;
    throw new Error(
      `${path} is at schema ${at}, this Pier speaks ${target}: a database is ` +
        `never downgraded. Restore ${newest ?? `a copy from ${backupsDir(path)}`}, or run the newer Pier.`,
    );
  }
  // Version 0 with tables is a database from before versioning existed.
  // Migration 1 assumes an empty file, so the collision it would hit says
  // "table already exists" — this says what is actually wrong and what to do.
  if (at === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) {
    throw new Error(
      `${path} predates schema versioning and cannot be upgraded — nothing was changed. ` +
        `Move the file aside and restart; channel credentials, tasks and the password start over.`,
    );
  }
  if (at === target) return;
  // One transaction for the statements *and* the version number: a crash
  // between them would leave a database whose version describes a schema it
  // does not have, which is worse than a crash.
  db.exec("BEGIN IMMEDIATE");
  // Re-read inside the lock. Two processes starting together both saw work to
  // do; the one that waited for the lock would otherwise replay migrations the
  // winner already committed and die on "table already exists", with a healthy
  // database in front of it.
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
  // Keep the write lock while a second, read-only connection copies the last
  // committed state. That connection may VACUUM while this one holds a RESERVED
  // lock; other Pier starts wait here instead of racing on the shared .tmp.
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
    // Which one, and that the database is untouched: the operator's next move
    // is to restore a backup or to report the migration, and a bare SQLite
    // error says neither.
    throw new Error(
      `migration ${step + 1} failed on ${path} — nothing was changed: ${String(err)}`,
      { cause: err },
    );
  }
  log.info(locked === 0 ? `schema created at version ${target}` : `schema ${locked} → ${target}`);
  if (path !== ":memory:") prune(snapshots(path).map(({ file }) => file));
}

/**
 * The copy that exists because `user_version` only counts up: the transaction
 * above protects against a migration that *failed*, and this against one that
 * succeeded and should not have. `VACUUM INTO`, not `cp`: under WAL the
 * committed tail of the database lives in the `-wal` sidecar.
 *
 * Written under a temporary name and renamed into place. `VACUUM INTO` refuses
 * an existing target, so the alternative is deleting the previous snapshot
 * first — which means the likely failure here, a full disk, leaves neither the
 * old snapshot nor a complete new one. A rename is atomic: the `.bak` name only
 * ever refers to a finished copy.
 */
function snapshot(path: string, at: number): void {
  const bak = join(backupsDir(path, true), `${basename(path)}.v${at}.bak`);
  copyDatabase(path, bak);
  log.info(`pre-migration backup: ${bak}`);
}

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

/**
 * One directory for every copy of this database, `db/backups/`. Beside the
 * database was fine while there was one snapshot per schema; a restore point
 * per release turns that into a listing where the live file and its sidecars
 * are hard to pick out, and "which of these do I not delete" is the wrong
 * question to make an operator answer under pressure.
 *
 * `create` also adopts what an older Pier wrote next to the database, so the
 * restore procedure names one location instead of two forever.
 */
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

/** The copies of one kind: `v<schema>` or `release-<version>`. Disjoint
 *  prefixes, so each kind is counted and pruned on its own. */
function listBackups(path: string, kind: string): string[] {
  const dir = backupsDir(path);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(path)}.${kind}`;
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".bak"));
}

/** Pre-migration snapshots, newest schema first — the number in the name is an
 *  ordinal, so it orders them without asking the filesystem. */
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

/** Release restore points, newest copy first. Ordered by mtime: the name holds
 *  a Pier version, and comparing those means reimplementing semver here — while
 *  two updates of one instance are never in flight at the same moment. Legacy
 *  `pier.db.release.bak` shares the prefix, so it ages out like the rest. */
function releases(path: string): string[] {
  return listBackups(path, "release")
    .map((name) => join(backupsDir(path), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Keep the newest few, oldest first out. Nobody restores a database from four
 *  upgrades ago, and every one of these is the size of the whole database. */
function prune(newestFirst: string[]): void {
  for (const file of newestFirst.slice(KEEP_BACKUPS)) {
    rmSync(file, { force: true });
    log.info(`removed superseded backup: ${file}`);
  }
}

/**
 * The database holds the password hash, so it is not world-readable — and
 * neither are the sidecars, where a 0644 `-wal` would leak exactly what the
 * 0600 database is hiding. Done after the migration, so the sidecars that
 * writing created exist by now; SQLite gives later ones the database's mode.
 * The directory too: it exists only to hold this database and its sidecars
 * (paths.ts puts them under their own `db/`, away from the boards PIER_HOME
 * also holds), so nothing else needs to see into it.
 */
function restrict(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  chmodSync(dirname(path), 0o700);
  // Full copies of the same secrets, one directory down.
  if (existsSync(backupsDir(path))) chmodSync(backupsDir(path), 0o700);
}
