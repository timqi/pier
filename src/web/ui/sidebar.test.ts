// The rail's pure rules: which pinned sessions are Desk's and which are
// Projects' (`splitDesk`), and which desk conversation came before the one on
// screen (`previousDesk`, the transcript's history chain). Both are functions,
// but they live in a module that grabs
// its DOM nodes at import time — so the handful of globals that import touches
// are stubbed here, rather than adding a DOM implementation to the dev
// dependencies for one pure function (AGENTS.md, principle 8).

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./sidebar.js";

type Split = (
  list: SessionInfo[],
  deskDir: string | null,
) => { newest: SessionInfo | null; rest: SessionInfo[] };

type Previous = (
  list: SessionInfo[],
  deskDir: string | null,
  currentId: string | null,
) => SessionInfo | null;

let splitDesk: Split;
let previousDesk: Previous;

beforeAll(async () => {
  vi.stubGlobal("document", { querySelector: () => ({ append() {} }), addEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {} });
  vi.stubGlobal("navigator", { userAgent: "test" });
  const mod = await import("./sidebar.js");
  splitDesk = mod.splitDesk;
  previousDesk = mod.previousDesk;
});

const DESK = "/home/t/.pier/desk";

const session = (id: string, cwd: string, createdAt: number): SessionInfo => ({
  id,
  cwd,
  createdAt,
  state: "idle",
  pinned: true,
  unread: false,
  channel: "web",
  activeRuns: 0,
});

describe("splitDesk", () => {
  it("takes the desk rows out of Projects", () => {
    const rows = [
      session("a", "/code/pier", 3),
      session("desk-1", DESK, 1),
      session("b", "/code/other", 2),
    ];
    const { newest, rest } = splitDesk(rows, DESK);
    expect(newest?.id).toBe("desk-1");
    expect(rest.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("points at the newest — a reset makes one, and the row follows it", () => {
    const rows = [session("old", DESK, 1), session("new", DESK, 9), session("mid", DESK, 5)];
    const { newest, rest } = splitDesk(rows, DESK);
    expect(newest?.id).toBe("new");
    // The predecessors leave Projects too, and stay reachable through ⌘K:
    // every pinned session is a row there.
    expect(rest).toEqual([]);
  });

  it("matches on the canonical spelling only — the server resolves it", () => {
    const rows = [session("aliased", "/home/t/link/desk", 1)];
    expect(splitDesk(rows, DESK).newest).toBeNull();
    expect(splitDesk(rows, "/home/t/link/desk").newest?.id).toBe("aliased");
  });

  it("has no row to point at when no desk session exists", () => {
    expect(splitDesk([session("a", "/code/pier", 1)], DESK)).toEqual({
      newest: null,
      rest: [expect.objectContaining({ id: "a" }) as unknown as SessionInfo],
    });
  });

  it("leaves every row to Projects before the desk path is known", () => {
    const rows = [session("a", DESK, 1)];
    const { newest, rest } = splitDesk(rows, null);
    expect(newest).toBeNull();
    expect(rest).toEqual(rows);
  });
});

describe("previousDesk", () => {
  const chain = [
    session("desk-1", DESK, 100),
    session("desk-2", DESK, 200),
    session("desk-3", DESK, 300),
    session("work", "/code/pier", 250),
  ];

  it("walks back one reset at a time", () => {
    expect(previousDesk(chain, DESK, "desk-3")?.id).toBe("desk-2");
    expect(previousDesk(chain, DESK, "desk-2")?.id).toBe("desk-1");
    expect(previousDesk(chain, DESK, "desk-1")).toBeNull();
  });

  it("is Desk only — an ordinary session has no lineage here", () => {
    expect(previousDesk(chain, DESK, "work")).toBeNull();
  });

  it("ignores everything outside the desk folder", () => {
    const rows = [...chain, session("other", "/code/other", 290)];
    expect(previousDesk(rows, DESK, "desk-3")?.id).toBe("desk-2");
  });

  it("has nothing to chain before the desk path is known", () => {
    expect(previousDesk(chain, null, "desk-3")).toBeNull();
  });

  it("says null for a session the client does not hold, and for none selected", () => {
    expect(previousDesk(chain, DESK, "ghost")).toBeNull();
    expect(previousDesk(chain, DESK, null)).toBeNull();
  });

  it("ends the chain on an equal createdAt rather than cycling through it", () => {
    const tied = [session("a", DESK, 500), session("b", DESK, 500)];
    expect(previousDesk(tied, DESK, "a")).toBeNull();
    expect(previousDesk(tied, DESK, "b")).toBeNull();
  });
});
