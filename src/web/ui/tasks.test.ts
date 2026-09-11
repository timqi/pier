// Real Tasks/Runs navigation, shared details and HTTP with a small DOM double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPage, RunView, TaskDefinition, TaskGroup, TaskMessage } from "../../tasks/types.js";

class Element {
  children: (Element | string)[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
  className = "";
  value = "";
  scrollTop = 0;
  open = false;
  checked = false;
  disabled = false;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onscroll: (() => void) | null = null;
  ontoggle: (() => void) | null = null;
  constructor(readonly tag = "div") {}
  get childElementCount() { return this.children.length; }
  get isConnected(): boolean { return this === root || (this.parent?.isConnected ?? false); }
  append(...children: (Element | string)[]) {
    for (const child of children) if (child instanceof Element) child.parent = this;
    this.children.push(...children);
  }
  appendChild(child: Element) { this.append(child); return child; }
  replaceChildren(...children: (Element | string)[]) {
    for (const child of this.children) if (child instanceof Element) child.parent = null;
    this.children = []; this.append(...children);
  }
  replaceWith(next: Element) {
    if (!this.parent) return;
    next.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 1, next); this.parent = null;
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelector(selector: string): Element | null {
    return walk(this).find((el) => selector === "[data-task-detail]" ? "taskDetail" in el.dataset : el.attrs.role === "alert") ?? null;
  }
  get text(): string { return this.children.map((child) => typeof child === "string" ? child : child.text).join(""); }
}
function walk(el: Element): Element[] {
  return el.children.flatMap((child) => child instanceof Element ? [child, ...walk(child)] : []);
}
const make = (tag: string, classes = "", ...children: (Element | string)[]) => {
  const el = new Element(tag); el.className = classes; el.append(...children); return el;
};
vi.mock("./dom.js", () => ({
  h: (...args: Parameters<typeof make>) => make(...args), fmtDuration: (ms: number) => `${ms}ms`,
  consoleView: (_root: Element, show: (arg?: string, query?: string) => void) => {
    const view = { visible: false, show(arg?: string, query?: string) { view.visible = true; show(arg, query); }, hide() { view.visible = false; } }; return view;
  },
}));
vi.mock("./form.js", () => ({
  CONTROL: "",
  button: (label: string) => make("button", "", label),
  badge: (label: string) => make("span", "", label),
  empty: (label: string) => make("p", "", label),
  toolbar: (...children: (Element | string)[]) => make("div", "", ...children),
  segmented: (options: [string, string][], value: string, change: (key: string) => void) =>
    make("div", "", ...options.map(([label, key]) => {
      const el = make("button", key === value ? "active" : "", label); el.onclick = () => change(key); return el;
    })),
  select: (_options: unknown, value: string) => { const el = new Element("select"); el.value = value; return el; },
}));
vi.mock("./task-editor.js", () => ({ openTaskEditor: vi.fn() }));

import { createTasksView } from "./tasks.js";
import { openTaskEditor } from "./task-editor.js";
import { createRunsView } from "./runs.js";
let root: Element;
let tasksView: ReturnType<typeof createTasksView>;
let runsView: ReturnType<typeof createRunsView>;
let task: TaskDefinition;
let run: RunView;
let page: RunPage;
let group: TaskGroup;
let messages: TaskMessage[];
let fetcher: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
let failMessages: boolean;
let delayRun: Promise<void> | null;
let currentSession: string | null;
const openRuns = vi.fn<(filters: Record<string, string>, id?: string) => void>();
const openTask = vi.fn<(id?: string) => void>();
const loadSessions = vi.fn<() => Promise<void>>();
const settled = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const button = (text: string) => walk(root).find((el) => el.tag === "button" && el.text === text);
async function click(text: string) {
  if (text === "New task") tasksView.create();
  else { expect(button(text), text).toBeDefined(); button(text)!.onclick!(); }
  await settled();
}
const raw = () => walk(root).find((el) => el.tag === "details" && el.text.startsWith("Raw record"))!;
async function change(label: string, value: string) {
  const input = walk(root).find((el) => el.attrs["aria-label"] === label)!;
  input.value = value; input.onchange!(); await settled();
}
beforeEach(async () => {
  root = new Element(); failMessages = false; delayRun = null; currentSession = null; messages = [];
  task = { id: "task-a", kind: "task", name: "Review", description: "", archived: false, enabled: true,
    trigger: { type: "manual" }, action: { type: "bash", cwd: "/test", script: "true" }, callback: { type: "none" },
    timeoutSeconds: 60, revision: 1, creator: "console", createdBySessionId: null, nextRunAt: null, createdAt: 1, updatedAt: 1 };
  run = { id: "run-a", taskId: task.id, taskRevision: 1, state: "running", queuedAt: 1, startedAt: 2, finishedAt: null, triggerSource: "manual",
    result: { type: "bash", exitCode: 0, stdout: "result text", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    targetSessionId: null, parentRunId: null, resumedFromRunId: null, groupId: null,
    sourceSessionId: null, invokedBySessionId: null, sessionMode: null, callbackSessionId: null, callbackState: null,
    callbackError: null, callbackAttempts: 0, callbackNextAttemptAt: null, background: false, input: null,
    context: { definition: task }, probe: null, matched: null, error: null, skipReason: null, groupCallbackState: null };
  page = { runs: [run], nextCursor: null };
  group = { id: "group-a", join: "all", invokedBySessionId: "s1", callbackSessionId: "s1", memberRunIds: [run.id, "run-c"],
    winnerRunId: null, callbackState: "delivered", callbackError: null, callbackAttempts: 1, callbackNextAttemptAt: null,
    createdAt: 1, finishedAt: 2 };
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
  });
  vi.stubGlobal("Option", class extends Element {
    constructor(label: string, value: string) { super("option"); this.append(label); this.value = value; }
  });
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("/api/tasks?")) return Response.json(url.includes("archived") ? [] : [{ ...task, lastRun: run }]);
    if (url.startsWith("/api/task-runs?")) return Response.json(page);
    if (url === "/api/tasks/task-a") return Response.json(task);
    if (url === "/api/tasks/task-a/runs") return Response.json([run]);
    if (url === "/api/task-runs/run-a") { if (delayRun) await delayRun; return Response.json(run); }
    if (url.startsWith("/api/task-runs/group-a")) return Response.json({ error: "unknown task run: group-a" }, { status: 404 });
    if (url === "/api/task-groups/group-a") return Response.json({ group, members: [run, { ...run, id: "run-c" }] });
    if (url === "/api/task-groups/run-b") return Response.json({ error: "unknown task group: run-b" }, { status: 404 });
    if (url.startsWith("/api/task-runs/run-b")) return Response.json({ error: "unknown task run: run-b" }, { status: 404 });
    if (url.endsWith("/messages")) return failMessages ? Response.json({ error: "Ledger failed" }, { status: 500 }) : Response.json(messages);
    if (url.endsWith("/resume")) return Response.json({ ...run, id: "continued-run" });
    if (url.endsWith("/cancel") || url.endsWith("/reply")) return Response.json({});
    if (url.endsWith("/run")) return Response.json({ runId: run.id });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  openRuns.mockReset().mockImplementation((filters, id) => {
    tasksView.hide(); runsView.show(id, new URLSearchParams(filters).toString());
  });
  openTask.mockReset().mockImplementation((id) => { runsView.hide(); tasksView.show(id); });
  vi.mocked(openTaskEditor).mockClear();
  loadSessions.mockReset().mockResolvedValue();
  tasksView = createTasksView(root as unknown as HTMLElement, () => [], loadSessions, vi.fn(), () => currentSession, openRuns, openTask);
  runsView = createRunsView(root as unknown as HTMLElement, vi.fn(), openRuns, openTask);
  tasksView.show(); await settled();
});
afterEach(() => vi.unstubAllGlobals());

describe("Tasks", () => {
  it("loads and refreshes details without lists, and ignores another task's refresh", async () => {
    fetcher.mockClear();
    openTask(task.id); await settled();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/tasks/task-a", "/api/tasks/task-a/runs"]);
    fetcher.mockClear(); tasksView.refresh("other-task"); await settled();
    expect(fetcher).not.toHaveBeenCalled();
    tasksView.refresh(task.id); await settled();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/tasks/task-a", "/api/tasks/task-a/runs"]);
    expect(loadSessions).not.toHaveBeenCalled();
  });
  it("coalesces a burst of detail refreshes independently of a pending list", async () => {
    let releaseList!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseList = resolve; }));
    tasksView.refresh(); await settled();
    let releaseDetail!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseDetail = resolve; }));
    fetcher.mockClear(); openTask(task.id); tasksView.refresh(); tasksView.refresh(); await settled();
    expect(fetcher.mock.calls).toHaveLength(2);
    releaseDetail(Response.json(task)); await settled();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/tasks/task-a", "/api/tasks/task-a/runs", "/api/tasks/task-a", "/api/tasks/task-a/runs",
    ]);
    expect(root.querySelector("[data-task-detail]")?.dataset.taskDetail).toBe(task.id);
    releaseList(Response.json([])); await settled();
    expect(fetcher.mock.calls).toHaveLength(4);
  });
  it.each(["task-b", "list", "hidden"])("uses current navigation when a queued detail load executes (%s)", async (destination) => {
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    fetcher.mockClear(); openTask(task.id); tasksView.refresh(); await settled();
    if (destination === "hidden") tasksView.hide();
    else openTask(destination === "list" ? undefined : destination);
    await settled(); fetcher.mockClear();
    if (destination === "task-b") {
      fetcher.mockResolvedValueOnce(Response.json({ ...task, id: "task-b", name: "Next task" }));
      fetcher.mockResolvedValueOnce(Response.json([]));
    }
    release(Response.json({ ...task, name: "Old detail" })); await settled();
    expect(root.text).not.toContain("Old detail");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(destination === "task-b" ? ["/api/tasks/task-b", "/api/tasks/task-b/runs"] : []);
    if (destination === "task-b") expect(root.querySelector("[data-task-detail]")?.dataset.taskDetail).toBe(destination);
  });
  it("reports list failure without blocking subsequent details", async () => {
    fetcher.mockRejectedValueOnce(new Error("list offline"));
    tasksView.refresh(); await settled();
    expect(root.text).toContain("Failed to load tasks: Error: list offline");
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url) => url.startsWith("/api/tasks?") ? Promise.reject(new Error("list offline")) : original(url));
    fetcher.mockClear(); openTask(task.id); await settled();
    expect(root.querySelector("[data-task-detail]")?.dataset.taskDetail).toBe(task.id);
    expect(root.text).not.toContain("list offline");
    expect(fetcher.mock.calls).toHaveLength(2);
  });
  it.each([false, true])("ignores a late list response (failure: %s) without delaying details", async (fail) => {
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    tasksView.refresh(); tasksView.refresh(); await settled();
    fetcher.mockClear(); openTask(task.id); await settled();
    const detail = root.querySelector("[data-task-detail]");
    expect(detail?.dataset.taskDetail).toBe(task.id);
    release(fail ? Response.json({ error: "old list failed" }, { status: 500 }) : Response.json([{ ...task, name: "Old list", lastRun: null }]));
    await settled();
    expect(root.querySelector("[data-task-detail]")).toBe(detail);
    expect(root.text).not.toContain("old list failed");
    expect(fetcher.mock.calls).toHaveLength(2);
    openTask(); await settled();
    expect(button("Review")).toBeDefined();
    expect(button("Old list")).toBeUndefined();
  });
  it.each([[false, undefined], [true, undefined], [false, "task-b"], [true, "task-b"]] as const)("ignores an older detail after returning to the same task (failure: %s, via: %s)", async (fail, via) => {
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    openTask(task.id); await settled(); openTask(via); await settled(); openTask(task.id); await settled();
    let releaseCurrent!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseCurrent = resolve; }));
    release(fail ? Response.json({ error: "old detail failed" }, { status: 500 }) : Response.json({ ...task, name: "Old detail" }));
    await settled();
    expect(root.text).not.toContain("Old detail");
    expect(root.text).not.toContain("old detail failed");
    releaseCurrent(Response.json(task)); await settled();
    expect(root.querySelector("[data-task-detail]")?.dataset.taskDetail).toBe(task.id);
  });
  it("keeps late task details out of another view", async () => {
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    openTask(task.id); await settled(); openRuns({}, run.id); await settled();
    release(Response.json(task)); await settled();
    expect(root.text).toContain("Raw record");
    expect(root.querySelector("[data-task-detail]")).toBeNull();
  });
  it("preserves list filters and search after detail navigation", async () => {
    await change("Status", "archived"); await change("Trigger", "cron");
    const search = walk(root).find((el) => el.attrs["aria-label"] === "Search tasks")!;
    search.value = "review"; search.oninput!();
    openTask(task.id); await settled(); openTask(); await settled();
    for (const [label, value] of [["Status", "archived"], ["Trigger", "cron"], ["Search tasks", "review"]]) {
      expect(walk(root).find((el) => el.attrs["aria-label"] === label)?.value).toBe(value);
    }
  });
  it("loads complete active editor targets only when opened from an archived, filtered list", async () => {
    await change("Status", "archived"); await change("Trigger", "cron");
    expect(fetcher).not.toHaveBeenCalledWith("/api/tasks?state=active", undefined);
    expect(loadSessions).not.toHaveBeenCalled();
    const targets = [{ ...task, lastRun: null }, { ...task, id: "child", kind: "subagent", lastRun: null }];
    fetcher.mockResolvedValueOnce(Response.json(targets)); await click("New task");
    expect(fetcher).toHaveBeenLastCalledWith("/api/tasks?state=active", undefined);
    expect(loadSessions).toHaveBeenCalledOnce();
    expect(vi.mocked(openTaskEditor).mock.lastCall![0].tasks()).toEqual(targets);
  });
  it("loads editor targets from details and retains the last good candidates on failure", async () => {
    openTask(task.id); await settled(); await click("Edit");
    const targets = vi.mocked(openTaskEditor).mock.lastCall![0].tasks();
    expect(targets).toHaveLength(1);
    expect(vi.mocked(openTaskEditor).mock.lastCall![1]).toEqual(task);
    fetcher.mockRejectedValueOnce(new Error("targets offline")); await click("Edit");
    expect(root.text).toContain("Failed to load tasks: Error: targets offline");
    expect(vi.mocked(openTaskEditor).mock.lastCall![0].tasks()).toEqual(targets);
    expect(openTaskEditor).toHaveBeenCalledTimes(2);
  });
  it.each(["New task", "Edit"])("propagates session failure from %s to global reporting even after refresh or navigation", async (label) => {
    for (const move of ["stay", "refresh", "navigate", "hide"]) {
      openTask(label === "Edit" ? task.id : undefined); await settled();
      let reject!: (error: Error) => void;
      loadSessions.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
      // Observe the click's terminal promise before it rejects. This asserts the
      // browser reporting boundary without producing Vitest unhandled rejections;
      // a catch that swallows the failure makes this promise resolve and fails.
      let terminal!: Promise<unknown>;
      const then = Promise.prototype.then;
      /* oxlint-disable unicorn/no-thenable -- Observe native Promise chains, not a custom thenable. */
      Promise.prototype.then = function (...args) {
        const next = Reflect.apply(then, this, args);
        terminal = next;
        return next;
      };
      try {
        if (label === "New task") tasksView.create(); else button(label)!.onclick!();
      } finally { Promise.prototype.then = then; }
      /* oxlint-enable unicorn/no-thenable */
      const reported = expect(terminal).rejects.toThrow("sessions offline");
      if (move === "refresh") tasksView.show(label === "Edit" ? task.id : undefined);
      if (move === "navigate") openTask(label === "Edit" ? undefined : task.id);
      if (move === "hide") tasksView.hide();
      await settled(); reject(new Error("sessions offline")); await reported; await settled();
      expect(openTaskEditor).not.toHaveBeenCalled();
    }
  });
  it.each(["New task", "Edit"])("opens %s after a same-page refresh while candidates are pending", async (label) => {
    if (label === "Edit") { openTask(task.id); await settled(); }
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    await click(label);
    tasksView.show(label === "Edit" ? task.id : undefined); await settled();
    release(Response.json([{ ...task, lastRun: null }])); await settled();
    expect(openTaskEditor).toHaveBeenCalledOnce();
    expect(vi.mocked(openTaskEditor).mock.lastCall![1]).toEqual(label === "Edit" ? task : undefined);
  });
  it("reports candidate failure after a same-task refresh", async () => {
    openTask(task.id); await settled();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    await click("Edit"); tasksView.refresh(); await settled();
    release(Response.json({ error: "candidates offline" }, { status: 500 })); await settled();
    expect(root.text).toContain("candidates offline");
    expect(openTaskEditor).toHaveBeenCalledOnce();
  });
  it.each([false, true])("accepts Edit during a same-task refresh and after it fails (failed: %s)", async (failed) => {
    openTask(task.id); await settled();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    tasksView.refresh(); await settled();
    if (failed) { release(Response.json({ error: "refresh offline" }, { status: 500 })); await settled(); }
    await click("Edit");
    expect(openTaskEditor).toHaveBeenCalledOnce();
    if (!failed) { release(Response.json(task)); await settled(); }
  });
  it.each(["New task", "Edit"])("does not open a late %s dialog after navigation", async (label) => {
    if (label === "Edit") { openTask(task.id); await settled(); }
    let release!: () => void;
    loadSessions.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await click(label);
    if (label === "Edit") openTask(); else openTask(task.id);
    await settled(); release(); await settled();
    expect(openTaskEditor).not.toHaveBeenCalled();
  });
  it.each(["New task", "Edit"])("ignores a stale %s button while the next detail loads", async (label) => {
    if (label === "Edit") { openTask(task.id); await settled(); }
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    fetcher.mockResolvedValueOnce(Response.json([]));
    openTask("task-b"); await settled(); await click(label);
    expect(loadSessions).not.toHaveBeenCalled();
    expect(openTaskEditor).not.toHaveBeenCalled();
    release(Response.json({ ...task, id: "task-b", name: "Next task" })); await settled();
    expect(root.querySelector("[data-task-detail]")?.dataset.taskDetail).toBe("task-b");
  });
  it.each(["task", "runs"])("reports a failed detail %s request", async (endpoint) => {
    if (endpoint === "runs") fetcher.mockResolvedValueOnce(Response.json(task));
    fetcher.mockRejectedValueOnce(new Error("detail offline"));
    openTask(task.id); await settled();
    expect(root.text).toContain(endpoint === "task" ? "Failed to load task: Error: detail offline" : "Failed to load the task's runs: Error: detail offline");
  });
  it.each([false, true])("ignores late editor candidates after leaving Tasks (failure: %s)", async (fail) => {
    openTask(task.id); await settled();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    await click("Edit"); openRuns({}, run.id); await settled();
    release(fail ? Response.json({ error: "old candidates failed" }, { status: 500 }) : Response.json([]));
    await settled();
    expect(openTaskEditor).not.toHaveBeenCalled();
    expect(root.text).toContain("Raw record");
    expect(root.text).not.toContain("old candidates failed");
  });
  it("only requests explicit tasks, has search/archive, and no cross-entry tabs or subagent filter", async () => {
    expect(fetcher).toHaveBeenCalledWith("/api/tasks?state=active&kind=task", undefined);
    expect(walk(root).some((el) => el.attrs["aria-label"] === "Type")).toBe(false);
    expect(button("Sessions")).toBeUndefined();
    const input = walk(root).find((el) => el.attrs["aria-label"] === "Search tasks")!;
    input.value = "absent"; input.oninput!();
    expect(button("Review")).toBeUndefined();
    await change("Status", "archived");
    expect(fetcher).toHaveBeenCalledWith("/api/tasks?state=archived&kind=task", undefined);
  });
  it("keeps configuration selected after refresh and omits manual schedule controls", async () => {
    openTask(task.id); await settled(); await click("Definition"); tasksView.refresh(); await settled();
    expect(root.text).toContain("Scripttrue"); expect(button("Definition")!.className).toBe("active");
    expect(button("Pause schedule")).toBeUndefined(); expect(root.text).not.toContain("Enabled");
    await click("All runs"); expect(openRuns).toHaveBeenLastCalledWith({ taskId: task.id });
  });
  it("opens recent runs and new manual executions directly in Runs", async () => {
    openTask(task.id); await settled();
    walk(root).find((el) => el.tag === "button" && el.text.startsWith("running"))!.onclick!(); await settled();
    expect(openRuns).toHaveBeenLastCalledWith({}, "run-a"); expect(root.text).toContain("Raw record");
    openTask(task.id); await settled(); await click("Run now"); expect(openRuns).toHaveBeenLastCalledWith({}, "run-a");
  });
  it("keeps a failed manual launch visible and does not navigate to a nonexistent run", async () => {
    openTask(task.id); await settled();
    fetcher.mockRejectedValueOnce(new Error("offline")); await click("Run now");
    expect(root.text).toContain("Failed to run task: Error: offline"); expect(openRuns).not.toHaveBeenCalled();
  });
  it("preserves system action details and owner controls after navigation into Runs", async () => {
    task.action = { type: "system", name: "config-sync" };
    task.trigger = { type: "cron", expression: "*/5 * * * *", timezone: "UTC" };
    run.result = { type: "system", text: "Applied revision 2" };
    openTask(task.id); await settled(); await click("Definition");
    expect(root.text).toContain("ActionSystem"); expect(root.text).toContain("System actionconfig-sync");
    for (const label of ["Edit", "Archive", "Pause schedule"]) expect(button(label)!.disabled).toBe(true);
    openRuns({}, run.id); await settled();
    expect(root.text).toContain("Applied revision 2"); expect(root.text).toContain("System actionconfig-sync");
    expect(root.text).not.toContain("Watch did not match");
  });
  it("does not call unmatched probes successful actions or infer watch firing from disabled", async () => {
    task.trigger = { type: "watch", cwd: "/test", script: "true", intervalSeconds: 30, mode: "once" };
    task.enabled = false; run.state = "succeeded"; run.matched = false;
    tasksView.refresh(); await settled(); expect(root.text).toContain("No match"); expect(root.text).toContain("Paused"); expect(root.text).not.toContain("Triggered");
  });
});

describe("Runs", () => {
  it("keeps an expanded date range and draft input when task choices arrive late", async () => {
    let release!: (response: Response) => void;
    fetcher.mockResolvedValueOnce(Response.json(page));
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    openRuns({}); await settled();
    const dates = walk(root).find((el) => el.tag === "details" && el.className === "filter-dates")!;
    const from = walk(root).find((el) => el.attrs["aria-label"] === "From")!;
    dates.open = true;
    from.value = "2026-09-08T10:30";
    release(Response.json([{ ...task, name: "New options" }])); await settled();
    expect(walk(root).find((el) => el.attrs["aria-label"] === "From")).toBe(from);
    expect(from.value).toBe("2026-09-08T10:30");
    expect(dates.open).toBe(true);
    expect(walk(root).find((el) => el.attrs["aria-label"] === "Task")?.text).toContain("New options");
  });

  it("shows flat children and attention, preserves filters across keyset pages, toggles probes", async () => {
    run.parentRunId = "parent"; run.callbackState = "failed"; run.groupCallbackState = "abandoned";
    page.nextCursor = { queuedAt: 1, id: run.id };
    openRuns({ taskId: task.id }); await settled();
    expect(root.text).toContain("Callback not delivered (failed)");
    expect(root.text).toContain("Group callback not delivered (abandoned)");
    expect(root.text).toContain("Parent parent"); expect(root.text).toContain("Show unmatched probes");
    expect(root.text).not.toContain("hidden"); expect(root.text).not.toContain("included");
    expect(walk(root).some((el) => el.attrs["aria-label"] === "Attention")).toBe(false);
    await change("State", "failed"); await change("Source", "watch"); await click("Older runs");
    const query = openRuns.mock.lastCall![0]; expect(query).toMatchObject({ taskId: task.id, state: "failed", source: "watch", cursor: JSON.stringify(page.nextCursor) });
    const checkbox = walk(root).find((el) => el.tag === "input" && !el.attrs["aria-label"])!;
    checkbox.checked = true; checkbox.onchange!(); await settled();
    expect(openRuns.mock.lastCall![0]).toMatchObject({ showUnmatched: "true", taskId: task.id });
    expect(openRuns.mock.lastCall![0]).not.toHaveProperty("cursor");
  });
  it("keeps raw disclosure and scroll on refresh, shows probe output and the readable snapshot", async () => {
    run.probe = { exitCode: 1, stdout: "probe stdout", stderr: "probe stderr", stdoutTruncated: true, stderrTruncated: false };
    openRuns({}, run.id); await settled(); raw().open = true; raw().ontoggle!();
    const pane = root.children[0] as Element; pane.scrollTop = 140; pane.onscroll!();
    run.callbackState = "abandoned"; runsView.refresh(); await settled();
    expect(raw().open).toBe(true); expect(pane.scrollTop).toBe(140);
    expect(root.text).toContain("probe stdout"); expect(root.text).toContain("probe stderr");
    expect(root.text).toContain("Configuration snapshot (revision 1)"); expect(root.text).toContain("Scripttrue");
    expect(root.text).toContain("Callback not delivered (abandoned)");
  });
  it("redraws a detail only when its payload changed, and never leaves a fresh pane on the placeholder", async () => {
    openRuns({}, run.id); await settled();
    const before = walk(root).find((el) => el.tag === "button" && el.text === "Stop run")!;
    runsView.refresh(); await settled();
    // Same payload: the button that was on screen still is — not a fresh copy.
    expect(walk(root).find((el) => el.tag === "button" && el.text === "Stop run")).toBe(before);
    // Reopening the same run rebuilds the pane; the unchanged payload may not skip drawing into it.
    openRuns({}, run.id); await settled();
    expect(root.text).not.toContain("Loading run..."); expect(root.text).toContain("result text");
  });
  it("reports ledger failure and retains the run and back navigation", async () => {
    failMessages = true; openRuns({}, run.id); await settled();
    expect(root.text).toContain("Ledger failed"); expect(root.text).toContain("result text");
    await click("Runs"); expect(root.text).not.toContain("Raw record");
  });
  it("does not let delayed detail replace another view", async () => {
    let release!: () => void; delayRun = new Promise<void>((resolve) => { release = resolve; });
    openRuns({}, run.id); await settled(); openTask(task.id); await settled(); await click("Definition");
    release(); await settled(); expect(root.text).toContain("Scripttrue"); expect(root.text).not.toContain("Raw record");
  });
  it("offers Stop while a run is live and nothing that types a message to it", async () => {
    task.action = { type: "agent", session: { mode: "fresh", cwd: "/test" }, prompt: "work" };
    openRuns({}, run.id); await settled();
    expect(button("Stop run")).toBeDefined();
    expect(button("Steer")).toBeUndefined(); expect(button("Continue")).toBeUndefined();
    run.targetSessionId = "child"; run.state = "succeeded"; runsView.refresh(); await settled();
    // Finished: the session that delegated it is where a follow-up is typed.
    expect(button("Stop run")).toBeUndefined(); expect(button("Continue")).toBeUndefined();
    expect(button("Open session")).toBeDefined();
  });
  it("asks before stopping a run, and stops it once the answer is yes", async () => {
    openRuns({}, run.id); await settled();
    const confirm = window.confirm as unknown as ReturnType<typeof vi.fn>;
    confirm.mockReturnValueOnce(false);
    await click("Stop run");
    expect(fetcher).not.toHaveBeenCalledWith("/api/task-runs/run-a/cancel", expect.anything());
    await click("Stop run");
    expect(fetcher).toHaveBeenCalledWith("/api/task-runs/run-a/cancel", expect.objectContaining({ method: "POST" }));
  });
  it("lists a run's control messages without offering to send one here", async () => {
    messages = [{ id: "m1", runId: run.id, kind: "steer", toSessionId: "child", fromSessionId: "supervisor", state: "pending", content: "Change course" } as TaskMessage];
    currentSession = "supervisor"; openRuns({}, run.id); await settled();
    expect(root.text).toContain("steer"); expect(root.text).toContain("Change course");
    expect(button("Steer")).toBeUndefined();
  });
  it("links parent, resume and wrapper child, and names the group without a page for it", async () => {
    run.parentRunId = "parent"; run.resumedFromRunId = "prior"; run.groupId = "group"; run.result = { type: "task", runId: "child", result: null };
    openRuns({}, run.id); await settled();
    expect(button("Parent: parent")).toBeDefined(); expect(button("Resumed from: prior")).toBeDefined();
    expect(button("Group: group")).toBeUndefined(); expect(root.text).toContain("Group: group");
    await click("Child result: child"); expect(openRuns).toHaveBeenLastCalledWith({}, "child");
  });
  it("resolves a group id on the run route to its members, and still reports a real unknown id", async () => {
    openRuns({}, "group-a"); await settled();
    expect(root.text).toContain("Task group \u00b7 join all"); expect(root.text).toContain("2 runs");
    expect(root.text).toContain("callback delivered"); expect(root.text).not.toContain("unknown task run");
    walk(root).find((el) => el.tag === "button" && el.text.startsWith("running"))!.onclick!();
    expect(openRuns).toHaveBeenLastCalledWith({}, run.id);
    openRuns({}, "run-b"); await settled();
    expect(root.text).toContain("unknown task run: run-b");
  });
});
