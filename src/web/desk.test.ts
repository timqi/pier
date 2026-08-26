// The desk folder's contract: seeded once, never written over, and opened
// through the same sequence every other session gets. Nothing here asserts on
// the templates' prose — freezing a prompt's wording freezes the one thing
// that must stay editable (docs/design/06-desk.md).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PIER_HOME } from "../paths.js";
import { deskDir, registerDeskRoutes, seedDesk } from "./desk.js";
import type { AgentSession, ContextUsage, SessionState, SessionSummary } from "../core/types.js";

/** A throwaway home; `realpath` because macOS's tmpdir is itself a symlink. */
const tmp = (): string => mkdtempSync(join(realpathSync(tmpdir()), "pier-desk-"));

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("desk seeding", () => {
  it("writes both files into a 0700 folder", async () => {
    const dir = join(tmp(), "desk");
    await seedDesk(dir);
    expect(mode(dir)).toBe(0o700);
    // Content is the templates' business; that there *is* content is this
    // module's — an empty AGENTS.md is a dispatcher with no instructions.
    for (const name of ["AGENTS.md", "projects.md"]) {
      expect(statSync(join(dir, name)).size).toBeGreaterThan(0);
    }
  });

  it("never writes over a file the user edited", async () => {
    const dir = join(tmp(), "desk");
    await seedDesk(dir);
    writeFileSync(join(dir, "AGENTS.md"), "mine");
    writeFileSync(join(dir, "projects.md"), "also mine");
    await seedDesk(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "projects.md"), "utf8")).toBe("also mine");
  });

  it("restores only the file that is missing", async () => {
    const dir = join(tmp(), "desk");
    await seedDesk(dir);
    writeFileSync(join(dir, "AGENTS.md"), "mine");
    rmSync(join(dir, "projects.md"));
    await seedDesk(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
    expect(statSync(join(dir, "projects.md")).size).toBeGreaterThan(0);
  });

  it("seeds a folder whose parents do not exist yet", async () => {
    const dir = join(tmp(), "nested", "desk");
    await seedDesk(dir);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("writes the templates 0600 — a dispatcher prompt is this instance's", async () => {
    const dir = join(tmp(), "desk");
    await seedDesk(dir);
    expect(mode(join(dir, "AGENTS.md"))).toBe(0o600);
    expect(mode(join(dir, "projects.md"))).toBe(0o600);
  });

  it("tightens a folder that already existed with a wider mode", async () => {
    const dir = join(tmp(), "desk");
    mkdirSync(dir, { mode: 0o755 });
    // mkdir's mode applies only to a directory it creates, so without the
    // chmod an existing 0755 desk folder kept it forever.
    await seedDesk(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("refuses a symlinked leaf instead of writing through it", async () => {
    const home = tmp();
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    const dir = join(home, "desk");
    symlinkSync(elsewhere, dir);
    // mkdir follows the link rather than failing, so the templates would have
    // landed in whatever it points at — named, not silently accepted.
    await expect(seedDesk(dir)).rejects.toThrow("symlink");
    expect(existsSync(join(elsewhere, "AGENTS.md"))).toBe(false);
  });

  it("refuses a leaf whose parent link takes it out of PIER_HOME", async () => {
    const home = tmp();
    const real = join(home, "real");
    mkdirSync(join(real, "desk"), { recursive: true });
    symlinkSync(real, join(home, "link"));
    await expect(seedDesk(join(home, "link", "desk"))).rejects.toThrow("resolves to");
    expect(existsSync(join(real, "desk", "AGENTS.md"))).toBe(false);
  });
});

describe("deskDir", () => {
  it("answers the canonical spelling of $PIER_HOME/desk", () => {
    mkdirSync(PIER_HOME, { recursive: true });
    // The whole point: a $PIER_HOME under a symlink and the cwd Pi reports
    // would otherwise be two strings, and the rail compares them for equality.
    expect(deskDir()).toBe(join(realpathSync(PIER_HOME), "desk"));
  });
});

describe("POST /api/desk", () => {
  afterEach(() => rmSync(deskDir(), { recursive: true, force: true }));

  /** One pinned desk session, as `SessionStateStore.projects()` hands it over. */
  const row = (id: string, createdAt: number, cwd = deskDir()): SessionSummary => ({
    id,
    cwd,
    createdAt,
  });

  interface Options {
    busEnabled?: boolean;
    /** The pinned rows the rail derives Desk from. */
    pinned?: SessionSummary[];
    state?: SessionState;
    /** `undefined` = a session that has not answered yet; `tokens: null` = one
     *  that just compacted. Both mean "unknown". */
    usage?: ContextUsage;
    activeRuns?: number;
    /** A ghost: Pi persisted nothing, so resuming it fails and the rail entry
     *  is dropped by the server's `ensureLoadable` (server.ts). */
    ghost?: boolean;
  }

  const setup = (
    { busEnabled = true, pinned = [], state = "idle", usage, activeRuns = 0, ghost }: Options = {},
  ) => {
    mkdirSync(PIER_HOME, { recursive: true });
    const openSession = vi.fn(async (cwd: string) => `session-in-${cwd}`);
    const load = vi.fn(async (id: string): Promise<Pick<AgentSession, "id" | "state" | "contextUsage">> => {
      if (ghost) throw new Error(`session ${id} no longer exists`);
      return { id, state, contextUsage: usage };
    });
    const app = new Hono();
    registerDeskRoutes(app, {
      openSession,
      pinned: () => pinned,
      load,
      activeRuns: () => activeRuns,
      busEnabled: () => busEnabled,
    });
    return { app, openSession, load };
  };

  const post = (app: Hono) => app.request("/api/desk", { method: "POST" });

  const FULL: ContextUsage = { tokens: 160_000, contextWindow: 200_000 }; // 0.8

  it("seeds the folder, then opens one session in it", async () => {
    const { app, openSession } = setup();
    const res = await post(app);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: `session-in-${deskDir()}`, cwd: deskDir(), fresh: true });
    expect(openSession.mock.calls).toEqual([[deskDir()]]);
    expect(statSync(join(deskDir(), "AGENTS.md")).size).toBeGreaterThan(0);
  });

  it("opens the newest desk session again while it still has room", async () => {
    const { app, openSession } = setup({
      pinned: [row("old", 1), row("newest", 9), row("elsewhere", 99, "/code/pier")],
      usage: { tokens: 20_000, contextWindow: 200_000 },
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "newest", cwd: deskDir(), fresh: false });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("resets on open when the newest one is idle and nearly full", async () => {
    const { app, openSession } = setup({ pinned: [row("newest", 9)], usage: FULL });
    const res = await post(app);
    expect(res.status).toBe(201);
    // The user's own click is the reset boundary: nothing mid-flight is cut,
    // and the folder it lands in is the one already there.
    expect(await res.json()).toEqual({ id: `session-in-${deskDir()}`, cwd: deskDir(), fresh: true });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("never resets a session that is mid-turn, however full it is", async () => {
    const { app, openSession } = setup({ pinned: [row("busy", 9)], state: "streaming", usage: FULL });
    expect(await (await post(app)).json()).toEqual({ id: "busy", cwd: deskDir(), fresh: false });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("never resets while a run it delegated is still in flight", async () => {
    const { app, openSession } = setup({ pinned: [row("dispatching", 9)], usage: FULL, activeRuns: 2 });
    // The worker reports back into *this* conversation; a fresh one would be
    // waiting for a report nobody sends it.
    expect(await (await post(app)).json()).toEqual({ id: "dispatching", cwd: deskDir(), fresh: false });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("does not reset on unknown usage — not before the first turn, not after a compaction", async () => {
    for (const usage of [undefined, { tokens: null, contextWindow: 200_000 }]) {
      const { app, openSession } = setup({ pinned: [row("quiet", 9)], usage });
      expect(await (await post(app)).json()).toEqual({ id: "quiet", cwd: deskDir(), fresh: false });
      expect(openSession).not.toHaveBeenCalled();
    }
  });

  it("treats a ghost as no session at all and opens a real one", async () => {
    const { app, openSession, load } = setup({ pinned: [row("ghost", 9)], ghost: true });
    const res = await post(app);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: `session-in-${deskDir()}`, cwd: deskDir(), fresh: true });
    // The cleanup is `load`'s (server.ts drops the rail entry there); this
    // route's job is not to hand back an id nothing can resume.
    expect(load).toHaveBeenCalledWith("ghost");
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("with the bus off, opens the session that exists — and never resets it", async () => {
    const { app, openSession } = setup({ busEnabled: false, pinned: [row("newest", 9)], usage: FULL });
    // Rehydration after a reset *is* the bus, so with it off a reset would
    // throw the conversation away and give the successor nothing to read.
    expect(await (await post(app)).json()).toEqual({ id: "newest", cwd: deskDir(), fresh: false });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("refuses with the bus off and no session at all, seeding nothing", async () => {
    const { app, openSession } = setup({ busEnabled: false });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain("bus is off");
    expect(existsSync(deskDir())).toBe(false);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("restores a deleted template on the click that opens the existing session", async () => {
    const { app } = setup({ pinned: [row("newest", 9)], usage: { tokens: 1, contextWindow: 200_000 } });
    mkdirSync(deskDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(deskDir(), "projects.md"), "mine");
    expect((await post(app)).status).toBe(200);
    expect(readFileSync(join(deskDir(), "projects.md"), "utf8")).toBe("mine");
    expect(statSync(join(deskDir(), "AGENTS.md")).size).toBeGreaterThan(0);
  });

  it("says so when the folder cannot be created", async () => {
    const { app, openSession } = setup();
    // A file where the directory belongs — the one seeding failure a user can
    // cause, and it must not look like a session that quietly never opened.
    writeFileSync(deskDir(), "not a directory");
    const res = await post(app);
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain("desk folder");
    expect(openSession).not.toHaveBeenCalled();
  });
});
