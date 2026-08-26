// The rail's one pure rule: which pinned sessions are Desk's and which are
// Projects'. `splitDesk` is a function, but it lives in a module that grabs
// its DOM nodes at import time — so the handful of globals that import touches
// are stubbed here, rather than adding a DOM implementation to the dev
// dependencies for one pure function (AGENTS.md, principle 8).

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./sidebar.js";

type Split = (
  list: SessionInfo[],
  deskDir: string | null,
) => { desk: SessionInfo[]; older: number; rest: SessionInfo[] };

let splitDesk: Split;
let DESK_CAP: number;

beforeAll(async () => {
  vi.stubGlobal("document", { querySelector: () => ({ append() {} }), addEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {} });
  vi.stubGlobal("navigator", { userAgent: "test" });
  const mod = await import("./sidebar.js");
  splitDesk = mod.splitDesk;
  DESK_CAP = mod.DESK_CAP;
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
    const { desk, older, rest } = splitDesk(rows, DESK);
    expect(desk.map((s) => s.id)).toEqual(["desk-1"]);
    expect(rest.map((s) => s.id)).toEqual(["a", "b"]);
    expect(older).toBe(0);
  });

  it("orders desk sessions newest first — a reset makes a new one", () => {
    const rows = [session("old", DESK, 1), session("new", DESK, 9), session("mid", DESK, 5)];
    expect(splitDesk(rows, DESK).desk.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps the section and says how many it left in ⌘K", () => {
    const rows = Array.from({ length: DESK_CAP + 3 }, (_, i) => session(`d${String(i)}`, DESK, i));
    const { desk, older, rest } = splitDesk(rows, DESK);
    expect(desk).toHaveLength(DESK_CAP);
    expect(older).toBe(3);
    // Capped, never dropped: the oldest are still sessions, just not rows.
    expect(desk.at(-1)?.createdAt).toBe(3);
    expect(rest).toEqual([]);
  });

  it("matches on the canonical spelling only — the server resolves it", () => {
    const rows = [session("aliased", "/home/t/link/desk", 1)];
    expect(splitDesk(rows, DESK).desk).toEqual([]);
    expect(splitDesk(rows, "/home/t/link/desk").desk.map((s) => s.id)).toEqual(["aliased"]);
  });

  it("leaves every row to Projects before the desk path is known", () => {
    const rows = [session("a", DESK, 1)];
    const { desk, older, rest } = splitDesk(rows, null);
    expect(desk).toEqual([]);
    expect(older).toBe(0);
    expect(rest).toEqual(rows);
  });
});
