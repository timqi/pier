import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIBRARIAN_CRON, LIBRARIAN_NAME, librarianPrompt, librarianSeam } from "./librarian.js";
import type { BusLibrarianRow } from "./types.js";

describe("the librarian's identity", () => {
  it("reads the prompt from the markdown beside the module, not from a copy", () => {
    const prompt = librarianPrompt();
    expect(prompt.startsWith("# Bus librarian")).toBe(true);
    // The .md is the only canonical copy — this is the assertion that fails if
    // someone inlines a second one and lets the two drift.
    expect(prompt).toBe(readFileSync(new URL("librarian-prompt.md", import.meta.url), "utf8"));
    // The three rules docs/bus.md promises the prompt carries.
    for (const rule of ["peek: true", "librarian-summary", ".librarian/proposals/"]) {
      expect(prompt).toContain(rule);
    }
  });

  it("is shipped by the build, not only by tsc", () => {
    // tsc copies no .md into dist/, so without this line an installed Pier has
    // a librarian whose prompt is missing — and the first sign of it would be a
    // failed click in production.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:assets"]).toContain("src/bus/librarian-prompt.md dist/bus/");
  });

  it("names a five-field cron the task layer accepts", () => {
    expect(LIBRARIAN_CRON.split(" ")).toHaveLength(5);
    // The marker detection is keyed on: a rename is a migration, not an edit.
    expect(LIBRARIAN_NAME).toBe("bus-librarian");
  });
});

describe("one librarian per directory", () => {
  /** main.ts's halves, faked: a task store, its realpath, and a create that
   *  takes a tick — which is the whole reason the race exists. */
  const seam = (links: Record<string, string> = {}) => {
    const created: string[] = [];
    const rows: BusLibrarianRow[] = [];
    return {
      created,
      rows,
      seam: librarianSeam({
        canonical: (cwd) => (cwd === "/unresolvable" ? undefined : links[cwd] ?? cwd),
        list: () => rows,
        create: async (cwd) => {
          await Promise.resolve();
          created.push(cwd);
          const row: BusLibrarianRow = {
            taskId: `task-${String(rows.length)}`,
            name: LIBRARIAN_NAME,
            cwd,
            schedule: `${LIBRARIAN_CRON} (UTC)`,
            enabled: true,
          };
          rows.push(row);
          return row;
        },
      }),
    };
  };

  it("seeds the canonical spelling, and finds it again under an alias", async () => {
    const { seam: s, created } = seam({ "/home/u/x": "/essd/u/x" });
    expect(await s.seed("/home/u/x")).toMatchObject({ created: true, librarian: { cwd: "/essd/u/x" } });
    // The alias and the physical path are one directory, so one librarian: the
    // other spelling would have maintained a blackboard nobody writes to.
    expect(await s.seed("/essd/u/x")).toMatchObject({ created: false, librarian: { taskId: "task-0" } });
    expect(await s.seed("/home/u/x")).toMatchObject({ created: false, librarian: { taskId: "task-0" } });
    expect(created).toEqual(["/essd/u/x"]);
  });

  it("creates one under two concurrent clicks, and tells the second so", async () => {
    const { seam: s, created } = seam();
    const [first, second] = await Promise.all([s.seed("/p"), s.seed("/p")]);
    expect(created).toEqual(["/p"]);
    expect(first).toMatchObject({ created: true });
    // Not the first one's answer handed out twice: the second click created
    // nothing, and a 201 for it would be a lie the Console would repeat.
    expect(second).toMatchObject({ created: false, librarian: { taskId: "task-0" } });
  });

  it("serializes two directories independently", async () => {
    const { seam: s, created } = seam();
    await Promise.all([s.seed("/a"), s.seed("/b"), s.seed("/a")]);
    expect(created.sort()).toEqual(["/a", "/b"]);
  });

  it("creates nothing for a path it cannot resolve", async () => {
    const { seam: s, created } = seam();
    await expect(s.seed("/unresolvable")).rejects.toThrow("canonical path");
    expect(created).toEqual([]);
  });

  it("keeps taking clicks after a create failed", async () => {
    const rows: BusLibrarianRow[] = [];
    let fail = true;
    const s = librarianSeam({
      canonical: (cwd) => cwd,
      list: () => rows,
      create: async (cwd) => {
        await Promise.resolve();
        if (fail) throw new Error("working directory does not exist");
        const row: BusLibrarianRow = {
          taskId: "task-0",
          name: LIBRARIAN_NAME,
          cwd,
          schedule: `${LIBRARIAN_CRON} (UTC)`,
          enabled: true,
        };
        rows.push(row);
        return row;
      },
    });
    // A rejected seed must not leave the directory locked behind a promise
    // nobody can settle — the Console's next click has to reach the store.
    await expect(s.seed("/p")).rejects.toThrow("does not exist");
    fail = false;
    expect(await s.seed("/p")).toMatchObject({ created: true });
  });
});
