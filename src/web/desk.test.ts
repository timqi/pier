// The desk folder's contract: seeded once, never written over, and opened
// through the same sequence every other session gets. Nothing here asserts on
// the templates' prose — freezing a prompt's wording freezes the one thing
// that must stay editable (docs/design/06-desk.md).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PIER_HOME } from "../paths.js";
import { deskDir, registerDeskRoutes, seedDesk } from "./desk.js";

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

  const setup = () => {
    mkdirSync(PIER_HOME, { recursive: true });
    const openSession = vi.fn(async (cwd: string) => `session-in-${cwd}`);
    const app = new Hono();
    registerDeskRoutes(app, openSession);
    return { app, openSession };
  };

  it("seeds the folder, then opens one session in it", async () => {
    const { app, openSession } = setup();
    const res = await app.request("/api/desk", { method: "POST" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: `session-in-${deskDir()}`, cwd: deskDir() });
    expect(openSession.mock.calls).toEqual([[deskDir()]]);
    expect(statSync(join(deskDir(), "AGENTS.md")).size).toBeGreaterThan(0);
  });

  it("is the reset button: a second click seeds nothing and opens another", async () => {
    const { app, openSession } = setup();
    await app.request("/api/desk", { method: "POST" });
    writeFileSync(join(deskDir(), "projects.md"), "mine");
    expect((await app.request("/api/desk", { method: "POST" })).status).toBe(201);
    expect(readFileSync(join(deskDir(), "projects.md"), "utf8")).toBe("mine");
    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it("says so when the folder cannot be created", async () => {
    const { app, openSession } = setup();
    // A file where the directory belongs — the one seeding failure a user can
    // cause, and it must not look like a session that quietly never opened.
    writeFileSync(deskDir(), "not a directory");
    const res = await app.request("/api/desk", { method: "POST" });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain("desk folder");
    expect(openSession).not.toHaveBeenCalled();
  });
});
