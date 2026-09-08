// The rail's order and its page, without a browser: pinned rows by hand then by
// birth, the rest by last activity, and twenty rows before "Load more".
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./dom.js", () => ({ $: () => ({}), basename: vi.fn(), h: (_tag: string, cls: string) => ({ cls }), relTime: vi.fn(), untitled: vi.fn() }));
vi.mock("./api.js", () => ({ sendJson: vi.fn() }));
vi.mock("./dir-picker.js", () => ({ pathTrigger: vi.fn() }));
vi.mock("./notifications.js", () => ({ setUnreadBadge: vi.fn() }));
vi.mock("./shell.js", () => ({ setAttention: vi.fn() }));
vi.mock("./shortcut.js", () => ({ shortcut: vi.fn() }));
let sidebar: typeof import("./sidebar.js");
beforeEach(async () => {
  vi.resetModules();
  sidebar = await import("./sidebar.js");
});
type Row = import("./sidebar.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: `/${id}`, createdAt: 0, state: "idle", pinned: false, unread: false, channel: "web", activeRuns: 0, ...over });
const ids = (rows: Row[]): string[] => rows.map((s) => s.id);

it("puts pinned rows first by their dragged place, never-dragged newest on top, then the rest by last activity", () => {
  const { pinned, rest } = sidebar.orderSessions([
    row("old", { modified: 10 }),
    row("fresh", { modified: 30 }),
    row("mid", { modified: 20 }),
    row("p-second", { pinned: true, sort: 1, createdAt: 9 }),
    row("p-first", { pinned: true, sort: 0, createdAt: 1 }),
    row("p-new", { pinned: true, createdAt: 5 }),
    row("p-newer", { pinned: true, createdAt: 6 }),
    // No transcript yet: created is the last thing that happened to it.
    row("nascent", { createdAt: 25 }),
  ]);
  expect(ids(pinned)).toEqual(["p-newer", "p-new", "p-first", "p-second"]);
  expect(ids(rest)).toEqual(["fresh", "nascent", "mid", "old"]);
});

it("shows twenty rows, pinned ones counted, and says how many wait behind Load more", () => {
  const list = [
    ...Array.from({ length: 3 }, (_, i) => row(`p${i}`, { pinned: true, createdAt: i })),
    ...Array.from({ length: 30 }, (_, i) => row(`s${i}`, { modified: 100 - i })),
  ];
  const first = sidebar.pageOf(list, sidebar.PAGE);
  expect(sidebar.PAGE).toBe(20);
  expect(ids(first.rows).slice(0, 3)).toEqual(["p2", "p1", "p0"]);
  expect(first.rows).toHaveLength(20);
  expect(ids(first.rows).at(-1)).toBe("s16");
  expect(first.hidden).toBe(13);
  const second = sidebar.pageOf(list, sidebar.PAGE * 2);
  expect(second.rows).toHaveLength(33);
  expect(second.hidden).toBe(0);
  // More pinned rows than the page: nothing below them is drawn, and they say so.
  const pinnedOnly = sidebar.pageOf(list, 2);
  expect(ids(pinnedOnly.rows)).toEqual(["p2", "p1"]);
  expect(pinnedOnly.hidden).toBe(31);
});

it("offers each directory once, newest session first", () => {
  expect(sidebar.distinctCwds([
    row("a", { cwd: "/x", createdAt: 1 }),
    row("b", { cwd: "/y", createdAt: 3 }),
    row("c", { cwd: "/x", createdAt: 2 }),
  ])).toEqual(["/y", "/x"]);
});

// An idle row draws nothing where the dot would be — the title takes the width.
it("draws no dot on an idle row and paints one only for something to look at", () => {
  const dot = (over: Partial<Row>) => sidebar.stateDot(row("x", over))[0] as unknown as { cls: string; title: string } | undefined;
  expect(dot({})).toBeUndefined();
  expect(dot({ state: "streaming" })?.cls).toContain("bg-green-500");
  expect(dot({ unread: true })?.cls).toContain("bg-amber-500");
  // Unread, but answering Slack: that turn was delivered where it came from.
  expect(dot({ unread: true, channel: "slack" })).toBeUndefined();
  expect(dot({ activeRuns: 2 })).toMatchObject({ cls: expect.stringContaining("bg-sky-500"), title: "2 subagents running" });
});
