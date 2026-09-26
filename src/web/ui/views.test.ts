// Hash routes and first-level entries on index.html's body, without loading chat or a browser runtime.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { button, fake, installPage, type FakeElement } from "./dom.testkit.js";

const mocks = vi.hoisted(() => {
  const view = () => ({ show: vi.fn(), hide: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: true });
  return { tasks: view(), runs: view(), activity: view(), files: view() };
});
vi.mock("./chat.js", () => ({ turnsPane: document.querySelector("#turns") }));
vi.mock("./composer.js", () => ({ syncQueuePanel: vi.fn() }));
vi.mock("./session-header.js", () => ({ renderHeader: vi.fn() }));
vi.mock("./sidebar.js", () => ({ orderSessions: () => ({ top: [], rest: [] }), renderSessions: vi.fn() }));
vi.mock("./tasks.js", () => ({ createTasksView: () => mocks.tasks }));
vi.mock("./runs.js", () => ({ createRunsView: () => mocks.runs }));
vi.mock("./activity.js", () => ({ createActivityView: () => mocks.activity }));
vi.mock("./boards.js", () => ({ createBoardsView: () => mocks.activity }));
vi.mock("./explorer.js", () => ({ createExplorerView: () => mocks.files }));
const el = (selector: string): FakeElement => fake(document.querySelector(selector));
// Neither the sidebar's Console rows nor form.pill expose their active state
// (no aria-current/aria-pressed), and panes hide by the `hidden` utility: the
// two class names are the only marks, named once here.
const lit = (row: FakeElement): boolean => row.classList.contains("bg-indigo-50");
const shown = (pane: FakeElement): boolean => !pane.classList.contains("hidden");
/** The mobile top bar: its title, and whether the session ⋯ menu beside it shows. */
const bar = (): [string, boolean] => [el("#mobile-title").textContent, shown(el("#mobile-menu"))];
const litRows = (): string[] => ["tasks", "boards", "settings"].filter((name) => lit(el(`#open-${name}`)));
const settled = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let views: typeof import("./views.js");
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  installPage();
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("history", { replaceState: (_a: unknown, _b: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  views = await import("./views.js");
  views.initViews({ sessions: () => [], loadSessions: async () => {}, currentId: () => null, currentSession: () => undefined, select: vi.fn(), maybeAckRead: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it("hosts Tasks, Runs and Activity as tabs of one Automation entry", async () => {
  const pane = el("#automation-view");
  const tabs = el("#automation-tabs");
  for (const name of ["tasks", "runs", "activity"] as const) {
    views.showConsole(name); await settled();
    expect(location.hash).toBe(`#/${name}`);
    // One title on the mobile bar, one lit sidebar row, whichever tab is open.
    expect(bar()).toEqual(["Automation", false]);
    expect(litRows()).toEqual(["tasks"]);
    expect(shown(pane)).toBe(true);
    // The strip redraws with the open view's pill active and the others as links.
    const drawn = ["Tasks", "Runs", "Activity"].map((label) => `${label}:${lit(button(tabs, label)!)}`);
    expect(drawn).toEqual(["Tasks", "Runs", "Activity"].map((label) => `${label}:${label.toLowerCase() === name}`));
  }
  // A pill click routes: Back walks tabs like any other view.
  button(tabs, "Runs")!.onclick!(); await settled();
  expect(location.hash).toBe("#/runs");
  // Boards is its own entry: the hub hides and its row goes dark.
  el("#open-boards").onclick!(); await settled();
  expect(litRows()).toEqual(["boards"]);
  expect(shown(pane)).toBe(false);
  expect(bar()).toEqual(["Boards", false]);
});
// The rail lights the open session only while the chat shows, so both switches repaint it.
it("repaints the rail when a Console view covers the chat and when the chat returns", async () => {
  const { renderSessions } = await import("./sidebar.js");
  views.showConsole("settings", "models"); await settled();
  expect(renderSessions).toHaveBeenCalledOnce();
  views.showChat();
  expect(renderSessions).toHaveBeenCalledTimes(2);
});
it("round-trips run deep links with standard query filters and Back", async () => {
  views.showRuns({ taskId: "task/a?b", state: "failed" }, "run/a"); await settled();
  expect(location.hash).toBe("#/runs/run%2Fa?taskId=task%2Fa%3Fb&state=failed");
  views.applyRoute(); await settled();
  expect(mocks.runs.show).toHaveBeenLastCalledWith("run/a", "taskId=task%2Fa%3Fb&state=failed");
  location.hash = "#/tasks/task-a"; views.applyRoute(); await settled();
  expect(mocks.tasks.show).toHaveBeenLastCalledWith("task-a", undefined);
  location.hash = "#/runs?taskId=task-a"; views.applyRoute(); await settled();
  expect(mocks.runs.show).toHaveBeenLastCalledWith(undefined, "taskId=task-a");
  views.showRun("child"); await settled(); expect(location.hash).toBe("#/runs/child");
});
it("routes Browse files as a folder plus the file to select, and hands both to the view", async () => {
  views.showFiles("/pi/skills/a b", "SKILL.md"); await settled();
  expect(location.hash).toBe("#/files/%2Fpi%2Fskills%2Fa%20b?select=SKILL.md");
  expect(mocks.files.show).toHaveBeenLastCalledWith("/pi/skills/a b", "select=SKILL.md");
  views.showFiles("/pi"); await settled();
  expect(location.hash).toBe("#/files/%2Fpi");
});
it("places creation in the Tasks tab strip only on the list route", async () => {
  const create = (): FakeElement | undefined => button(el("#automation-tabs"), "New task");
  views.showConsole("tasks"); await settled();
  create()!.onclick!();
  expect(mocks.tasks.create).toHaveBeenCalledOnce();
  views.showConsole("tasks", "task-a"); await settled();
  expect(create()).toBeUndefined();
  views.showConsole("runs"); await settled();
  expect(create()).toBeUndefined();
});
it("ignores malformed encoded routes without crashing", () => {
  location.hash = "#/runs/%E0%A4%A"; expect(() => views.applyRoute()).not.toThrow();
});
