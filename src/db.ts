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

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./log.js";
import { PIER_DB } from "./paths.js";

const log = logger("db");

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
];

let shared: DatabaseSync | undefined;

/**
 * The process's one connection, opened and migrated on first use. Every store
 * defaults to it; a test passes `openDb(":memory:")` instead.
 */
export const pierDb = (): DatabaseSync => (shared ??= openDb(PIER_DB));

/** Open a database, bring it to the current schema, and lock down its files.
 *  `migrations` is injectable only so tests can exercise an upgrade — there is
 *  exactly one real list. */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // Outside the transaction below: journal_mode is a property of the file, and
  // SQLite refuses to change it inside one.
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
    throw new Error(
      `${path} is at schema ${at}, this Pier speaks ${target}: a database is ` +
        `never downgraded. Restore ${path}.v*.bak, or run the newer Pier.`,
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
  // The transaction below only protects against a *failed* migration; the way
  // back from a successful one you regret is this snapshot. VACUUM INTO, not
  // cp: under WAL the committed tail lives in the -wal sidecar.
  if (at > 0 && path !== ":memory:") {
    const bak = `${path}.v${at}.bak`;
    rmSync(bak, { force: true }); // VACUUM INTO refuses to overwrite
    db.exec(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
    chmodSync(bak, 0o600); // it holds everything the 0600 database holds
    log.info(`pre-migration backup: ${bak}`);
  }
  // One transaction for the statements *and* the version number: a crash
  // between them would leave a database whose version describes a schema it
  // does not have, which is worse than a crash.
  db.exec("BEGIN IMMEDIATE");
  let step = at;
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
  log.info(at === 0 ? `schema created at version ${target}` : `schema ${at} → ${target}`);
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
}
