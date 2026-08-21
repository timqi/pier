// Where channels/ opens Pier's SQLite file. One helper so the path, the WAL
// pragma and the mkdir live in one place instead of once per store.
//
// The path is duplicated from tasks/store.ts rather than imported: channels/
// may depend on core/, never sideways on tasks/.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const defaultChannelDbPath = (): string =>
  join(process.env.PIER_HOME ?? join(homedir(), ".pier"), "pier.db");

/** Open the database and create this store's tables if they are missing. */
export function openChannelDb(path: string, schema: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;\n${schema}`);
  return db;
}
