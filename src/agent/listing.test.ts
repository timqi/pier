// What the session listing may and may not answer. Two halves: the retained
// scan pi.ts keeps — whose one forbidden answer from memory is "no such
// session", because a caller reads that as permission to start a replacement
// session (channels/conversations.ts) — and the index under it, whose job is to
// read a transcript once.

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { IndexedListing, type SessionRecord } from "./listing.js";

const listAll = vi.fn<() => Promise<SessionRecord[]>>();
const created = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SessionManager: {
    open: (path: string) => ({ path }),
    create: (cwd: string) => {
      created(cwd);
      return { path: `${cwd}/new`, getSessionDir: () => cwd };
    },
  },
  ModelRuntime: { create: async () => ({ streamSimple: () => ({}) }) },
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  createAgentSession: async ({ sessionManager }: { sessionManager: { path: string } }) => ({
    session: {
      sessionId: sessionManager.path,
      isStreaming: false,
      messages: [],
      dispose() {},
    },
  }),
}));

const { PiAgentFactory } = await import("./pi.js");

const info = (id: string): SessionRecord => ({
  id,
  path: `/s/${id}.jsonl`,
  cwd: "/tmp",
  created: 0,
  modified: 0,
});

let factory: InstanceType<typeof PiAgentFactory>;

beforeEach(() => {
  listAll.mockReset();
  created.mockReset();
  listAll.mockResolvedValue([info("s1")]);
  factory = new PiAgentFactory([], undefined, undefined, undefined, undefined, undefined, undefined, {
    scan: () => listAll(),
  });
});

describe("the retained session listing", () => {
  it("scans once for a burst of surfaces asking at the same time", async () => {
    const [a, b, c] = await Promise.all([factory.list(), factory.list(), factory.list()]);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect([a, b, c].map((rows) => rows.length)).toEqual([1, 1, 1]);
    await factory.list();
    expect(listAll).toHaveBeenCalledTimes(1); // still inside the TTL
  });

  it("re-scans before calling a session unknown, so a live conversation is not replaced", async () => {
    listAll.mockResolvedValue([]);
    await factory.list(); // fills the listing with a disk state that predates s9
    listAll.mockResolvedValue([info("s9")]);
    await expect(factory.resume("s9")).resolves.toMatchObject({ id: "/s/s9.jsonl" });
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("pays that second scan only when the first one was a memory of an older disk", async () => {
    listAll.mockResolvedValue([]);
    await expect(factory.resume("s9")).rejects.toThrow("unknown session: s9");
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  // The lookup four surfaces used to do by scanning the whole list: same rule
  // as resume(), because they all read "not found" as a fact and act on it.
  it("finds one session by id, and re-scans before reporting a miss", async () => {
    expect(await factory.find("s1")).toMatchObject({ id: "s1", cwd: "/tmp", createdAt: 0 });
    expect(listAll).toHaveBeenCalledTimes(1);

    // Inside the TTL, from the retained listing — a hit costs no scan.
    expect(await factory.find("s1")).toMatchObject({ id: "s1" });
    expect(listAll).toHaveBeenCalledTimes(1);

    // A miss is not answered from a memory of an older disk.
    listAll.mockResolvedValue([info("s1"), info("s9")]);
    expect(await factory.find("s9")).toMatchObject({ id: "s9" });
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("says nothing found once a fresh scan agrees, and pays for one only then", async () => {
    // Nothing retained yet, so this scan *is* the fresh one: no second.
    expect(await factory.find("s9")).toBeUndefined();
    expect(listAll).toHaveBeenCalledTimes(1);
    // Now the listing is a memory, and a miss against a memory earns a scan.
    expect(await factory.find("s9")).toBeUndefined();
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed scan as the answer", async () => {
    listAll.mockRejectedValueOnce(new Error("disk went away"));
    await expect(factory.list()).rejects.toThrow("disk went away");
    listAll.mockResolvedValue([info("s1")]);
    expect(await factory.list()).toHaveLength(1);
  });

  it("drops the listing when it opens a session of its own", async () => {
    await factory.list();
    await factory.create({ cwd: "/tmp/project" });
    await factory.list();
    expect(listAll).toHaveBeenCalledTimes(2);
    expect(created).toHaveBeenCalledWith("/tmp/project");
  });
});

// --- the index ---------------------------------------------------------------------

describe("the on-disk index", () => {
  let dir: string;
  let db: DatabaseSync;
  let listing: IndexedListing;

  const header = (id: string, cwd: string, at = "2026-01-01T00:00:00.000Z") =>
    JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd });
  const user = (text: string) =>
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  const rename = (name: string) =>
    JSON.stringify({ type: "session_info", id: "n1", parentId: "m1", name });

  /** One session file, `<sessions>/<project>/<id>.jsonl` as Pi lays them out. */
  const write = async (project: string, id: string, lines: string[]): Promise<string> => {
    const at = join(dir, project);
    await fs.mkdir(at, { recursive: true });
    const path = join(at, `${id}.jsonl`);
    await fs.writeFile(path, lines.map((l) => `${l}\n`).join(""));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pier-listing-"));
    db = openDb(":memory:");
    listing = new IndexedListing(dir, db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("titles a session by its first user message, and by its name once it has one", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p"), user("fix the parser")]);
    expect(await listing.scan()).toMatchObject([
      { id: "s1", cwd: "/p", title: "fix the parser", created: Date.parse("2026-01-01T00:00:00.000Z") },
    ]);
    await fs.appendFile(path, `${rename("parser work")}\n`);
    expect((await listing.scan())[0]?.title).toBe("parser work");
  });

  it("does not read a file whose size and mtime have not moved", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p"), user("first pass")]);
    const stamp = new Date(1_700_000_000_000);
    await fs.utimes(path, stamp, stamp);
    await listing.scan();
    // Same length, different content, same stamp: only a re-read could see the
    // new bytes, and getting the old title back is the proof that none did.
    const { size } = await fs.stat(path);
    const rewritten = [header("s1", "/p"), user("a different first message")]
      .map((l) => `${l}\n`).join("");
    await fs.writeFile(path, rewritten.padEnd(size).slice(0, size));
    await fs.utimes(path, stamp, stamp);
    expect((await listing.scan())[0]?.title).toBe("first pass");
  });

  // Same length, new mtime: the file was rewritten in place. Resuming from the
  // last offset would read no new bytes and then stamp the *old* derived title
  // with the *new* mtime — a row that matches on every later scan, so the
  // stale title would outlive the file it came from.
  it("re-reads a file rewritten at the same length", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p"), user("first pass")]);
    await listing.scan();
    const { size } = await fs.stat(path);
    const rewritten = [header("s1", "/p"), user("third pass")].map((l) => `${l}\n`).join("");
    expect(rewritten.length).toBe(size); // same length, or this proves nothing
    await fs.writeFile(path, rewritten);
    const later = new Date(Date.now() + 2000);
    await fs.utimes(path, later, later);
    expect((await listing.scan())[0]?.title).toBe("third pass");
  });

  it("reads a grown file from where the last scan stopped", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p"), user("first pass")]);
    await listing.scan();
    const before = await fs.readFile(path, "utf8");
    // Everything already parsed is replaced with same-length rubbish. A whole
    // re-read would fail on the header; the appended rename must still land.
    await fs.writeFile(path, `${"x".repeat(before.length - 1)}\n${rename("renamed")}\n`);
    expect(await listing.scan()).toMatchObject([{ id: "s1", cwd: "/p", title: "renamed" }]);
  });

  it("re-reads a file that shrank instead of resuming past its end", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p"), user("first pass")]);
    await listing.scan();
    await fs.writeFile(path, [header("s1", "/p"), user("rewritten")].map((l) => `${l}\n`).join(""));
    expect((await listing.scan())[0]?.title).toBe("rewritten");
  });

  it("leaves a partial trailing line for the next scan", async () => {
    const path = await write("--p--", "s1", [header("s1", "/p")]);
    await listing.scan();
    const line = user("landed mid-write");
    await fs.appendFile(path, line.slice(0, 20));
    expect((await listing.scan())[0]?.title).toBeUndefined();
    await fs.appendFile(path, `${line.slice(20)}\n`);
    expect((await listing.scan())[0]?.title).toBe("landed mid-write");
  });

  it("skips a file that is not a session, and forgets one that is gone", async () => {
    await write("--p--", "junk", ["{\"type\":\"message\",\"id\":\"x\"}"]);
    const path = await write("--p--", "s1", [header("s1", "/p")]);
    expect((await listing.scan()).map((s) => s.id)).toEqual(["s1"]);
    await fs.rm(path);
    expect(await listing.scan()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_index").get()).toMatchObject({ n: 0 });
  });

  it("lists the most recently touched session first", async () => {
    const old = await write("--a--", "s1", [header("s1", "/a")]);
    await write("--b--", "s2", [header("s2", "/b")]);
    await fs.utimes(old, new Date(1), new Date(1));
    expect((await listing.scan()).map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  // The guard on the shadow parser: nothing but a comparison notices when Pi's
  // format moves under it.
  it("keeps a row Pi's own reader agrees with", async () => {
    await write("--p--", "s1", [header("s1", "/p"), user("fix the parser")]);
    const [row] = await listing.scan();
    const wrong = await listing.audit(async () => [
      { id: "s1", cwd: "/p", created: new Date(row!.created), firstMessage: "fix the parser" },
    ]);
    expect(wrong).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_index").get()).toMatchObject({ n: 1 });
  });

  it("drops a row Pi's own reader reads differently, so the next scan re-reads it", async () => {
    await write("--p--", "s1", [header("s1", "/p"), user("fix the parser")]);
    const [row] = await listing.scan();
    const wrong = await listing.audit(async () => [
      { id: "s1", cwd: "/p", created: new Date(row!.created), name: "something else entirely" },
    ]);
    expect(wrong).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_index").get()).toMatchObject({ n: 0 });
    // Dropped, not corrupted: the next scan reads the file and agrees again.
    expect((await listing.scan())[0]?.title).toBe("fix the parser");
  });

  it("counts a session Pi does not know at all as a disagreement", async () => {
    await write("--p--", "s1", [header("s1", "/p")]);
    await listing.scan();
    expect(await listing.audit(async () => [])).toBe(1);
  });

  it("survives an empty sessions directory that does not exist yet", async () => {
    expect(await new IndexedListing(join(dir, "nope"), db).scan()).toEqual([]);
  });
});
