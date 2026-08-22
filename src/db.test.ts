import { existsSync, mkdtempSync, statSync } from "node:fs";
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
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual([
      "auth",
      "channels",
      "conversations",
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
    expect(version(second)).toBe(1);
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

    expect(() => openDb(path)).toThrow(/at schema 99, this Pier speaks 1/);
  });

  it("names the migration that failed and leaves the database untouched", () => {
    const path = dbPath();
    // Anything migration 1 collides with: a pre-0.0.1 database, in practice.
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE auth (whatever TEXT)");
    seed.close();

    expect(() => openDb(path)).toThrow(/migration 1 failed .* nothing was changed/s);
    const after = new DatabaseSync(path);
    expect(version(after)).toBe(0);
    expect(tables(after)).toEqual(["auth"]);
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
