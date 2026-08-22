// Where channels/ opens Pier's SQLite file. One helper so the WAL pragma and
// the mkdir live in one place instead of once per store; the path itself comes
// from paths.ts, which every area shares.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Open the database and create this store's tables if they are missing. */
export function openChannelDb(path: string, schema: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;\n${schema}`);
  return db;
}
