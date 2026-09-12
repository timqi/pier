// Hash routes and first-level entries, without loading chat or a browser runtime.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const elements = new Map<string, { onclick?: () => void; open?: boolean; ontoggle?: () => void; textContent: string; replaceChildren: ReturnType<typeof vi.fn>; classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> } }>();
  const element = (id: string) => {
    let el = elements.get(id);
    if (!el) { el = { textContent: "", replaceChildren: vi.fn(), classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } }; elements.set(id, el); }
    return el;
  };
  const view = () => ({ show: vi.fn(), hide: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: true });
  return { element, elements, tasks: view(), runs: view(), activity: view(), files: view(), bar: vi.fn(), pill: vi.fn() };
});
vi.mock("./dom.js", () => ({ $: mocks.element, h: vi.fn(), consoleView: vi.fn() }));
vi.mock("./form.js", () => ({ pill: mocks.pill, button: mocks.element, pageTitle: mocks.element }));
vi.mock("./chat.js", () => ({ turnsPane: mocks.element("turns") }));
vi.mock("./composer.js", () => ({ syncQueuePanel: vi.fn() }));
vi.mock("./session-header.js", () => ({ renderHeader: vi.fn() }));
vi.mock("./shell.js", () => ({ closeDrawer: vi.fn(), setBarTitle: mocks.bar }));
vi.mock("./sidebar.js", () => ({ orderSessions: () => ({ top: [], rest: [] }) }));
vi.mock("./shortcut.js", () => ({ shortcut: vi.fn() }));
vi.mock("./tasks.js", () => ({ createTasksView: () => mocks.tasks }));
vi.mock("./runs.js", () => ({ createRunsView: () => mocks.runs }));
vi.mock("./activity.js", () => ({ createActivityView: () => mocks.activity }));
vi.mock("./boards.js", () => ({ createBoardsView: () => mocks.activity }));
vi.mock("./explorer.js", () => ({ createExplorerView: () => mocks.files }));
const settled = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let views: typeof import("./views.js");
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("history", { replaceState: (_a: unknown, _b: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", {});
  views = await import("./views.js");
  views.initViews({ sessions: () => [], loadSessions: async () => {}, currentId: () => null, currentSession: () => undefined, select: vi.fn(), maybeAckRead: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it("hosts Tasks, Runs and Activity as tabs of one Automation entry", async () => {
  const pane = mocks.element("#automation-view");
  const tabs = mocks.element("#automation-tabs");
  for (const name of ["tasks", "runs", "activity"] as const) {
    views.showConsole(name); await settled();
    expect(location.hash).toBe(`#/${name}`);
    // One title on the mobile bar, one lit sidebar row, whichever tab is open.
    expect(mocks.bar).toHaveBeenLastCalledWith("Automation", false);
    expect(mocks.element("#open-tasks").classList.toggle).toHaveBeenLastCalledWith("bg-indigo-50", true);
    expect(pane.classList.toggle).toHaveBeenCalledWith("hidden", false);
    // The strip redraws with the open view's pill active and the others as links.
    const drawn = mocks.pill.mock.calls.slice(-3).map(([label, active]) => `${label}:${active}`);
    expect(drawn).toEqual(["Tasks", "Runs", "Activity"].map((label) => `${label}:${label.toLowerCase() === name}`));
    expect(tabs.replaceChildren).toHaveBeenCalled();
  }
  // A pill click routes: Back walks tabs like any other view.
  const [, , openRuns] = mocks.pill.mock.calls.at(-2)!;
  (openRuns as () => void)(); await settled();
  expect(location.hash).toBe("#/runs");
  // Boards is its own entry: the hub hides and its row goes dark.
  mocks.element("#open-boards").onclick!(); await settled();
  expect(mocks.element("#open-tasks").classList.toggle).toHaveBeenLastCalledWith("bg-indigo-50", false);
  expect(pane.classList.toggle).toHaveBeenLastCalledWith("flex", false);
  expect(mocks.bar).toHaveBeenLastCalledWith("Boards", false);
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
  views.showConsole("tasks"); await settled();
  const create = mocks.element("New task");
  expect(mocks.element("#automation-tabs").replaceChildren.mock.lastCall).toContain(create);
  create.onclick!();
  expect(mocks.tasks.create).toHaveBeenCalledOnce();
  views.showConsole("tasks", "task-a"); await settled();
  expect(mocks.element("#automation-tabs").replaceChildren.mock.lastCall).not.toContain(create);
  views.showConsole("runs"); await settled();
  expect(mocks.element("#automation-tabs").replaceChildren.mock.lastCall).not.toContain(create);
});
it("ignores malformed encoded routes without crashing", () => {
  location.hash = "#/runs/%E0%A4%A"; expect(() => views.applyRoute()).not.toThrow();
});
