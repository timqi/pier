// The rail's order and its page, without a browser: the working set in its own
// order, the rest by birth, and twenty rows before "Load more".
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
  ({ id, cwd: `/${id}`, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });
const ids = (rows: Row[]): string[] => rows.map((s) => s.id);

// `modified` is deliberately ignored: a background turn writing a transcript
// used to move its row, which is what made the rail jump.
it("puts the working set first in its own order, then the rest newest first", () => {
  const { top, rest } = sidebar.orderSessions([
    row("older", { createdAt: 10, modified: 90 }),
    row("newest", { createdAt: 30, modified: 1 }),
    row("newer", { createdAt: 20, modified: 50 }),
    row("w-second", { rank: 1, createdAt: 9 }),
    row("w-first", { rank: 0, createdAt: 1 }),
  ]);
  expect(ids(top)).toEqual(["w-first", "w-second"]);
  expect(ids(rest)).toEqual(["newest", "newer", "older"]);
});

it("shows twenty rows, the working set counted, and says how many wait behind Load more", () => {
  const list = [
    ...Array.from({ length: 3 }, (_, i) => row(`w${i}`, { rank: i, createdAt: i })),
    ...Array.from({ length: 30 }, (_, i) => row(`s${i}`, { createdAt: 100 - i })),
  ];
  const first = sidebar.pageOf(list, sidebar.PAGE);
  expect(sidebar.PAGE).toBe(20);
  expect(ids(first.rows).slice(0, 3)).toEqual(["w0", "w1", "w2"]);
  expect(first.rows).toHaveLength(20);
  expect(ids(first.rows).at(-1)).toBe("s16");
  expect(first.hidden).toBe(13);
  const second = sidebar.pageOf(list, sidebar.PAGE * 2);
  expect(second.rows).toHaveLength(33);
  expect(second.hidden).toBe(0);
  // A page shorter than the working set: nothing below it is drawn, and it says so.
  const topOnly = sidebar.pageOf(list, 2);
  expect(ids(topOnly.rows)).toEqual(["w0", "w1"]);
  expect(topOnly.hidden).toBe(31);
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
