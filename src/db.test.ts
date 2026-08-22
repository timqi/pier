import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";

const dbPath = (): string => join(mkdtempSync(join(tmpdir(), "pier-db-")), "pier.db");

const version = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as
    { name: string }[]).map((r) => r.name);

describe("openDb", () => {
  it("creates the whole schema and stamps the version it created", () => {
    const db = openDb(":memory:");
    expect(version(db)).toBe(2);
    expect(tables(db)).toEqual([
      "auth",
      "channels",
      "conversations",
      "credentials",
      "receipts",
      "session_state",
      "settings",
      "task_groups",
      "task_messages",
      "task_runs",
      "tasks",
    ]);
    db.close();
  });

  it("migrates nothing on a database already at this version", () => {
    const path = dbPath();
    const first = openDb(path);
    first.prepare("INSERT INTO settings(key, value) VALUES ('publicUrl', 'https://x')").run();
    first.close();

    const second = openDb(path);
    expect(version(second)).toBe(2);
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

    expect(() => openDb(path)).toThrow(/at schema 99, this Pier speaks 2/);
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

    const bak = new DatabaseSync(`${path}.v1.bak`);
    expect(version(bak)).toBe(1);
    expect(tables(bak)).toEqual(["a"]); // no b: taken before migration 2 ran
    bak.close();
    // The backup holds everything the 0600 database holds.
    expect(statSync(`${path}.v1.bak`).mode & 0o777).toBe(0o600);
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

    const baks = readdirSync(dirname(path)).filter((f) => f.endsWith(".bak")).sort();
    expect(baks).toEqual(["pier.db.v2.bak", "pier.db.v3.bak", "pier.db.v4.bak"]);
    // And no temporary file survived any of them.
    expect(readdirSync(dirname(path)).some((f) => f.endsWith(".tmp"))).toBe(false);

    // A start with nothing to do adds nothing.
    openDb(path, steps).close();
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".bak")).sort()).toEqual(baks);
  });

  it("leaves the database and the older snapshot alone when the snapshot fails", () => {
    const path = dbPath();
    openDb(path, ["CREATE TABLE a (x)"]).close();
    openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]).close();
    expect(existsSync(`${path}.v1.bak`)).toBe(true);

    // Nothing new can be written beside the database — a full disk, in effect.
    chmodSync(dirname(path), 0o500);
    try {
      // SQLite's own words, and proof that it is the snapshot that failed
      // rather than something incidental before it.
      expect(() => openDb(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)", "CREATE TABLE c (z)"]))
        .toThrow(/readonly/);
      // The upgrade did not happen, the snapshot that existed still does, and
      // no half-written file took the name of a backup.
      expect(existsSync(`${path}.v2.bak`)).toBe(false);
      expect(existsSync(`${path}.v1.bak`)).toBe(true);
    } finally {
      chmodSync(dirname(path), 0o700);
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
