import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupDb, openDb, statements } from "./db.js";

const dbDirs = new Set<string>();
const dbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pier-db-"));
  dbDirs.add(dir);
  return join(dir, "pier.db");
};

afterEach(() => {
  for (const dir of dbDirs) rmSync(dir, { recursive: true, force: true });
  dbDirs.clear();
});

/** Where db.ts puts every copy, and one copy's name in it. */
const backupsDir = (path: string): string => join(dirname(path), "backups");
const bakPath = (path: string, kind: string): string =>
  join(backupsDir(path), `pier.db.${kind}.bak`);

const version = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as
    { name: string }[]).map((r) => r.name);

const indexes = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as unknown as
    { name: string }[]).map((r) => r.name);

/** Winds a fresh database back past migrations 17 and 18, for the upgrade tests. */
const UNDO_17 = "DROP INDEX task_runs_time_id; DROP INDEX task_runs_visible_time; DROP INDEX task_runs_invoked_by;";

/** Winds one back past 20, which dropped the column 19 and 20 both write: an
 *  older user_version on its own would replay them against a table that no
 *  longer has it. */
const UNDO_20 = "ALTER TABLE session_state ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;";

/** Winds one back past 22, whose CREATE would otherwise collide with itself. */
const UNDO_22 = "DROP TABLE session_fts;";

/** Winds one back past 23, the vault table. */
const UNDO_23 = "DROP TABLE vault;";

describe("openDb", () => {
  it("creates the whole schema and stamps the version it created", () => {
    const db = openDb(":memory:");
    expect(version(db)).toBe(24);
    expect(tables(db)).toEqual([
      "auth",
      "channels",
      "conversations",
      "credentials",
      "push_identity",
      "push_subscriptions",
      "receipts",
      "restart_ledger",
      // The virtual table and the five shadow tables FTS5 keeps it in.
      "session_fts",
      "session_fts_config",
      "session_fts_content",
      "session_fts_data",
      "session_fts_docsize",
      "session_fts_idx",
      "session_index",
      "session_state",
      "settings",
      "task_groups",
      "task_messages",
      "task_runs",
      "tasks",
      "tools_sync_lock",
      "vault",
      "web_sessions",
    ]);
    expect(
      (db.prepare("PRAGMA table_info(session_state)").all() as unknown as { name: string }[])
        .map((column) => column.name),
    ).toEqual([
      // The summary a transcript already carries (title, created_at,
      // last_active) is not here: migration 9 dropped it. Neither are the
      // Projects lease's two columns (kept, pinned_at): migration 11 dropped
      // those with the lease itself, nor `pinned`, which migration 20 dropped
      // with pinning. project_sort is orphaned, not dropped (migration 19).
      "session_id",
      "unread",
      "cwd",
      "sort",
      "project_sort",
    ]);
    db.close();
  });

  it("migrates nothing on a database already at this version", () => {
    const path = dbPath();
    const first = openDb(path);
    first.prepare("INSERT INTO settings(key, value) VALUES ('publicUrl', 'https://x')").run();
    first.close();

    const second = openDb(path);
    expect(version(second)).toBe(24);
    // A re-run of migration 1 would have hit "table auth already exists"; the
    // row proves the schema was left alone rather than recreated.
    expect(second.prepare("SELECT value FROM settings").get()).toEqual({ value: "https://x" });
    second.close();
  });

  it("refuses a database written by a newer Pier instead of serving it", () => {
    const path = dbPath();
    const db = openDb(path);
    db.exec("PRAGMA user_version = 99");
    db.close();

    expect(() => openDb(path)).toThrow(/at schema 99, this Pier speaks 24/);
  });

  it("tells a pre-versioning database what it is instead of colliding with it", () => {
    const path = dbPath();
    // Version 0 with tables: a database from before migrations existed.
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE auth (whatever TEXT)");
    seed.close();

    expect(() => openDb(path)).toThrow(/predates schema versioning .* nothing was changed/s);
    const after = new DatabaseSync(path);
    expect(version(after)).toBe(0);
    expect(tables(after)).toEqual(["auth"]);
    after.close();
  });

  it("backs up before upgrading, and the backup is the pre-upgrade schema", () => {
    const path = dbPath();
    openDb(path, ["CREATE TABLE a (x)"]).close();

    const db = openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);
    expect(version(db)).toBe(2);
    db.close();

    const bak = new DatabaseSync(bakPath(path, "v1"));
    expect(version(bak)).toBe(1);
    expect(tables(bak)).toEqual(["a"]); // no b: taken before migration 2 ran
    bak.close();
    // The backup holds everything the 0600 database holds, and so does the
    // directory holding it.
    expect(statSync(bakPath(path, "v1")).mode & 0o777).toBe(0o600);
    expect(statSync(backupsDir(path)).mode & 0o777).toBe(0o700);
  });

  it("takes a release backup named for the version, even with no schema change", () => {
    const path = dbPath();
    const db = openDb(path);
    db.prepare("INSERT INTO settings(key, value) VALUES ('publicUrl', 'before')").run();
    db.close();

    expect(backupDb("0.4.2", path)).toBe(bakPath(path, "release-0.4.2"));
    const after = openDb(path);
    after.prepare("UPDATE settings SET value = 'after'").run();
    after.close();

    const bak = new DatabaseSync(bakPath(path, "release-0.4.2"), { readOnly: true });
    expect(bak.prepare("SELECT value FROM settings").get()).toEqual({ value: "before" });
    bak.close();
    expect(statSync(bakPath(path, "release-0.4.2")).mode & 0o777).toBe(0o600);
  });

  it("keeps the three newest release backups, and adopts one written beside the database", async () => {
    const path = dbPath();
    openDb(path).close();
    // What an older Pier left next to the file, before backups had a home.
    copyFileSync(path, `${path}.release.bak`);

    for (const v of ["0.1.0", "0.2.0", "0.3.0"]) {
      backupDb(v, path);
      await new Promise((done) => setTimeout(done, 5)); // mtime orders them
    }

    // The legacy copy was adopted, then aged out first as the oldest.
    expect(existsSync(`${path}.release.bak`)).toBe(false);
    expect(readdirSync(backupsDir(path)).sort()).toEqual([
      "pier.db.release-0.1.0.bak",
      "pier.db.release-0.2.0.bak",
      "pier.db.release-0.3.0.bak",
    ]);
  });

  it("replaces a version's own copy rather than adding a second name for it", () => {
    const path = dbPath();
    openDb(path).close();
    expect(backupDb("0.1.0", path)).toBe(backupDb("0.1.0", path));
    expect(readdirSync(backupsDir(path))).toEqual(["pier.db.release-0.1.0.bak"]);
  });

  it("never lets a version escape its filename", () => {
    const path = dbPath();
    openDb(path).close();
    expect(backupDb("../../etc/0.1.0", path)).toBe(bakPath(path, "release-.._.._etc_0.1.0"));
  });

  it("serializes the snapshot as well as the migration across processes", { timeout: 15_000 }, async () => {
    const path = dbPath();
    const first = "CREATE TABLE a (x TEXT)";
    const second = "CREATE TABLE b (y TEXT)";
    const seed = openDb(path, [first]);
    seed.exec(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000) " +
      "INSERT INTO a SELECT printf('%0200d', x) FROM n",
    );
    seed.close();

    const module = new URL("./db.ts", import.meta.url).href;
    const script = `import { openDb } from ${JSON.stringify(module)}; ` +
      `const db = openDb(process.argv[1], ${JSON.stringify([first, second])}); db.close();`;
    const run = (): Promise<number | null> => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], {
        stdio: "ignore",
      });
      child.once("close", resolve);
    });

    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    const after = new DatabaseSync(path, { readOnly: true });
    expect(version(after)).toBe(2);
    expect(tables(after)).toEqual(["a", "b"]);
    after.close();
  });

  it("keeps the three newest snapshots and removes what they supersede", () => {
    const path = dbPath();
    const steps = [
      "CREATE TABLE a (x)",
      "CREATE TABLE b (y)",
      "CREATE TABLE c (z)",
      "CREATE TABLE d (w)",
      "CREATE TABLE e (v)",
    ];
    // One upgrade at a time, the way releases arrive.
    for (let n = 1; n <= steps.length; n++) openDb(path, steps.slice(0, n)).close();

    const baks = readdirSync(backupsDir(path)).filter((f) => f.endsWith(".bak")).sort();
    expect(baks).toEqual(["pier.db.v2.bak", "pier.db.v3.bak", "pier.db.v4.bak"]);
    // And no temporary file survived any of them.
    expect(readdirSync(backupsDir(path)).some((f) => f.endsWith(".tmp"))).toBe(false);
    // The database's own directory holds the live file and its sidecars only.
    expect(readdirSync(dirname(path)).some((f) => f.endsWith(".bak"))).toBe(false);

    // A start with nothing to do adds nothing.
    openDb(path, steps).close();
    expect(readdirSync(backupsDir(path)).filter((f) => f.endsWith(".bak")).sort()).toEqual(baks);
  });

  it("leaves the database and the older snapshot alone when the snapshot fails", () => {
    const path = dbPath();
    openDb(path, ["CREATE TABLE a (x)"]).close();
    openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]).close();
    expect(existsSync(bakPath(path, "v1"))).toBe(true);

    // Nothing new can be written into the backups directory — a full disk, in
    // effect.
    chmodSync(backupsDir(path), 0o500);
    try {
      // SQLite's own words, and proof that it is the snapshot that failed
      // rather than something incidental before it.
      expect(() => openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)", "CREATE TABLE c (z)"]))
        .toThrow(/unable to open database: .*pier\.db\.v2\.bak\.tmp/);
      // The upgrade did not happen, the snapshot that existed still does, and
      // no half-written file took the name of a backup.
      expect(existsSync(bakPath(path, "v2"))).toBe(false);
      expect(existsSync(bakPath(path, "v1"))).toBe(true);
    } finally {
      chmodSync(backupsDir(path), 0o700);
    }
    const after = new DatabaseSync(path);
    expect(version(after)).toBe(2);
    after.close();
  });

  it("names the migration that failed and rolls the database back", () => {
    const path = dbPath();
    openDb(path, ["CREATE TABLE a (x)"]).close();

    expect(() => openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE a (x)"]))
      .toThrow(/migration 2 failed .* nothing was changed/s);
    const after = new DatabaseSync(path);
    expect(version(after)).toBe(1);
    expect(tables(after)).toEqual(["a"]);
    after.close();
  });

  it("indexes the global run list, on a database that predates it", () => {
    const path = dbPath();
    const before = openDb(path);
    before.exec(UNDO_23 + UNDO_22 + UNDO_20 + UNDO_17 + " PRAGMA user_version = 16");
    const insert = before.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("probe", "t", 3, "succeeded", null, JSON.stringify({ matched: false }));
    insert.run("failed", "t", 2, "failed", null, JSON.stringify({ matched: false }));
    insert.run("run", "t", 1, "succeeded", null, JSON.stringify({ matched: null }));
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(db.prepare("SELECT id, json FROM task_runs ORDER BY queued_at DESC").all()).toEqual([
      { id: "probe", json: JSON.stringify({ matched: false }) },
      { id: "failed", json: JSON.stringify({ matched: false }) },
      { id: "run", json: JSON.stringify({ matched: null }) },
    ]);
    expect(db.prepare("PRAGMA table_xinfo(task_runs)").all().map((row) => row.name)).not.toContain("unmatched");
    expect(indexes(db)).not.toContain("task_runs_unmatched_time");
    const plan = (sql: string): string => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
    const seek = plan("SELECT json FROM task_runs WHERE (queued_at, id) < (2, 'z') ORDER BY queued_at DESC, id DESC LIMIT 50");
    expect(seek).toContain("task_runs_time_id");
    expect(seek).not.toContain("TEMP B-TREE");
    const visible = plan("SELECT json FROM task_runs WHERE NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0) AND (queued_at, id) < (2, 'z') ORDER BY queued_at DESC, id DESC LIMIT 50");
    expect(visible).toContain("task_runs_visible_time");
    expect(visible).not.toContain("TEMP B-TREE");
    db.close();
  });

  it("indexes the two columns the scheduler sweeps, on a database that predates them", () => {
    const path = dbPath();
    // Wound back to 14: the migration has to arrive as an upgrade of a
    // populated database, which is how every live instance meets it.
    const before = openDb(path);
    before.exec(
      "DROP INDEX task_runs_callback_state; DROP INDEX task_messages_state;" +
        " DROP INDEX tasks_due; ALTER TABLE tasks DROP COLUMN next_run_at;" +
        UNDO_23 + UNDO_22 + UNDO_20 + UNDO_17 + " PRAGMA user_version = 14",
    );
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(indexes(db)).toContain("task_runs_callback_state");
    expect(indexes(db)).toContain("task_messages_state");
    // And the planner uses them rather than scanning, which is the point.
    db.prepare(
      "INSERT INTO task_runs(id, task_id, queued_at, state, callback_state, json)" +
        " VALUES ('r1', 't1', 1, 'done', 'pending', '{}')",
    ).run();
    expect(
      JSON.stringify(
        db.prepare("EXPLAIN QUERY PLAN SELECT json FROM task_runs WHERE callback_state = 'pending'")
          .all(),
      ),
    ).toContain("task_runs_callback_state");
    db.close();
  });

  it("carries every task's next run into a column an older database never had", () => {
    const path = dbPath();
    const before = openDb(path);
    before.exec(
      "DROP INDEX tasks_due; ALTER TABLE tasks DROP COLUMN next_run_at;" +
        UNDO_23 + UNDO_22 + UNDO_20 + UNDO_17 + " PRAGMA user_version = 15",
    );
    // Three rows the upgrade has to tell apart: one due, two that never are.
    before.prepare("INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)")
      .run("t1", 1, JSON.stringify({ id: "t1", nextRunAt: 5000 }));
    before.prepare("INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)")
      .run("t2", 1, JSON.stringify({ id: "t2", nextRunAt: null }));
    before.prepare("INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)")
      .run("t3", 1, JSON.stringify({ id: "t3" }));
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(
      db.prepare("SELECT id, next_run_at FROM tasks ORDER BY id").all(),
    ).toEqual([
      { id: "t1", next_run_at: 5000 },
      { id: "t2", next_run_at: null },
      { id: "t3", next_run_at: null },
    ]);
    db.prepare("UPDATE tasks SET json = ? WHERE id = 't1'")
      .run(JSON.stringify({ id: "t1", nextRunAt: 7000 }));
    expect(db.prepare("SELECT next_run_at FROM tasks WHERE id = 't1'").get())
      .toEqual({ next_run_at: 7000 });
    // The tick's query, and the point of the column: the index answers it.
    expect(
      JSON.stringify(
        db.prepare(
          "EXPLAIN QUERY PLAN SELECT json FROM tasks" +
            " WHERE next_run_at IS NOT NULL AND next_run_at <= 6000",
        ).all(),
      ),
    ).toContain("tasks_due");
    db.close();
  });

  it("unpins every session a database pinned while pinned meant listed", () => {
    const path = dbPath();
    // Wound back to 18: every web session ever created carried pinned = 1,
    // because that was membership in Projects. 19 reset that, and 20 read
    // whatever was still pinned as the working set — so these two, unpinned by
    // 19, hold no slot. The marks are gone because 21 clears every one of
    // them; what this test is about is the pins.
    const before = openDb(path);
    before.exec(
      UNDO_23 + UNDO_22 + UNDO_20 +
        "INSERT INTO session_state(session_id, pinned, unread, cwd, sort, project_sort)" +
        " VALUES ('s1', 1, 1, '/a', 2, 0), ('s2', 1, 0, '/b', NULL, 1); PRAGMA user_version = 18",
    );
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(db.prepare("SELECT session_id, unread, sort FROM session_state ORDER BY session_id").all())
      .toEqual([
        { session_id: "s1", unread: 0, sort: null },
        { session_id: "s2", unread: 0, sort: null },
      ]);
    db.close();
  });

  // Every mark a database carries was written under the old rule — for IM and
  // task sessions too, which nothing here can ever ack. Cleared once, so what
  // is left is only what the workbench marks for itself (web/server.ts).
  it("clears the marks a database made before unread meant the workbench's own", () => {
    const path = dbPath();
    const before = openDb(path);
    before.exec(
      "INSERT INTO session_state(session_id, unread, sort) VALUES ('im', 1, NULL), ('own', 1, 0);" +
        UNDO_23 + UNDO_22 + " PRAGMA user_version = 20",
    );
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    // The row itself stays: its place in the working set is not a mark.
    expect(db.prepare("SELECT session_id, unread, sort FROM session_state ORDER BY session_id").all())
      .toEqual([
        { session_id: "im", unread: 0, sort: null },
        { session_id: "own", unread: 0, sort: 0 },
      ]);
    db.close();
  });

  // The pinned rows are what somebody was working on, so they seed the set the
  // rail now maintains itself: their arranged order, never-dragged first, and
  // no more of them than the set holds.
  it("seeds the working set from the pinned rows, and drops the rest of the pins", () => {
    const path = dbPath();
    const before = openDb(path);
    before.exec(UNDO_23 + UNDO_22 + UNDO_20);
    const insert = before.prepare(
      "INSERT INTO session_state(session_id, pinned, unread, sort) VALUES (?, ?, ?, ?)",
    );
    insert.run("dragged-second", 1, 0, 1);
    insert.run("dragged-first", 1, 0, 0);
    insert.run("never-dragged", 1, 1, null);
    // Nine pins for eight slots, and one row that is not pinned at all but
    // still carries the place a drag once gave it.
    for (let i = 0; i < 6; i++) insert.run(`p${String(i)}`, 1, 0, 10 + i);
    insert.run("unpinned", 0, 1, 3);
    before.exec("PRAGMA user_version = 19");
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(
      db.prepare("SELECT session_id FROM session_state WHERE sort IS NOT NULL ORDER BY sort, session_id")
        .all().map((row) => (row as unknown as { session_id: string }).session_id),
    ).toEqual(["never-dragged", "dragged-first", "dragged-second", "p0", "p1", "p2", "p3", "p4"]);
    // The ninth pin and the stale place are gone — and so is every mark, which
    // is 21's doing and has its own test.
    expect(db.prepare("SELECT sort FROM session_state WHERE session_id = 'p5'").get()).toEqual({ sort: null });
    expect(db.prepare("SELECT sort, unread FROM session_state WHERE session_id = 'unpinned'").get())
      .toEqual({ sort: null, unread: 0 });
    db.close();
  });

  it("moves channel credentials into the vault verbatim, and a name filed first stays", () => {
    const path = dbPath();
    const before = openDb(path);
    before.exec("PRAGMA user_version = 23");
    const insert = before.prepare("INSERT INTO channels(platform, json) VALUES (?, ?)");
    insert.run("slack", JSON.stringify({ enabled: true, token: "v1:aa:bot", appToken: "v1:aa:app", users: [] }));
    insert.run("telegram", JSON.stringify({ enabled: false, token: "", appToken: "" }));
    insert.run("lark", JSON.stringify({ token: "v1:aa:id" }));
    before.prepare("INSERT INTO vault VALUES (?, ?, ?)").run("SLACK_TOKEN", "v1:aa:filed", 1);
    before.close();

    const db = openDb(path);
    expect(version(db)).toBe(24);
    expect(db.prepare("SELECT name, value FROM vault ORDER BY name").all()).toEqual([
      { name: "LARK_APP_ID", value: "v1:aa:id" },
      { name: "SLACK_APP_TOKEN", value: "v1:aa:app" },
      { name: "SLACK_TOKEN", value: "v1:aa:filed" },
    ]);
    // Neither key survives in any row, filled or empty.
    expect(db.prepare("SELECT platform, json FROM channels ORDER BY platform").all()).toEqual([
      { platform: "lark", json: "{}" },
      { platform: "slack", json: JSON.stringify({ enabled: true, users: [] }) },
      { platform: "telegram", json: JSON.stringify({ enabled: false }) },
    ]);
    db.close();
  });

  it("keeps the database, its sidecars and its directory to the owner", () => {
    const path = dbPath();
    // The auth hash lives in here, and it is written to the -wal file before
    // any checkpoint — a 0644 sidecar leaks what the 0600 database hides.
    const db = openDb(path);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    db.close();
  });
});

describe("statements", () => {
  it("compiles one SQL string once and re-binds it per call", () => {
    const db = openDb(":memory:");
    const sql = statements(db);
    const insert = "INSERT INTO settings(key, value) VALUES (?, ?)";
    const select = "SELECT value FROM settings WHERE key = ?";

    expect(sql(insert)).toBe(sql(insert));
    expect(sql(select)).not.toBe(sql(insert));

    // The whole reason it may be cached: one statement, many bindings.
    sql(insert).run("a", "1");
    sql(insert).run("b", "2");
    expect(sql(select).get("a")).toEqual({ value: "1" });
    expect(sql(select).get("b")).toEqual({ value: "2" });
    expect(sql(select).get("a")).toEqual({ value: "1" });
    expect(sql(select).get("missing")).toBeUndefined();
    db.close();
  });

  it("caches per connection, so a statement is never used on another database", () => {
    const one = openDb(":memory:");
    const two = openDb(":memory:");
    const sql = "SELECT COUNT(*) AS n FROM settings";
    expect(statements(one)(sql)).not.toBe(statements(two)(sql));
    one.close();
    two.close();
  });
});
