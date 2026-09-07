// Real Tasks/Runs navigation, shared details and HTTP with a small DOM double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPage, RunView, TaskDefinition, TaskMessage } from "../../tasks/types.js";

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
import { createRunsView } from "./runs.js";
let root: Element;
let tasksView: ReturnType<typeof createTasksView>;
let runsView: ReturnType<typeof createRunsView>;
let task: TaskDefinition;
let run: RunView;
let page: RunPage;
let messages: TaskMessage[];
let fetcher: ReturnType<typeof vi.fn>;
let failMessages: boolean;
let delayRun: Promise<void> | null;
let currentSession: string | null;
const openRuns = vi.fn<(filters: Record<string, string>, id?: string) => void>();
const openTask = vi.fn<(id?: string) => void>();
const settled = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const button = (text: string) => walk(root).find((el) => el.tag === "button" && el.text === text);
async function click(text: string) { expect(button(text), text).toBeDefined(); button(text)!.onclick!(); await settled(); }
const raw = () => walk(root).find((el) => el.tag === "details" && el.text.startsWith("▶Raw record"))!;
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
    targetSessionId: null, parentRunId: null, rootRunId: "run-a", resumedFromRunId: null, groupId: null, depth: 0,
    sourceSessionId: null, invokedBySessionId: null, sessionMode: null, callbackSessionId: null, callbackState: null,
    callbackError: null, callbackAttempts: 0, callbackNextAttemptAt: null, background: false, input: null,
    context: { definition: task }, probe: null, matched: null, error: null, skipReason: null, pendingDecisionId: null, groupCallbackState: null };
  page = { runs: [run], nextCursor: null };
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("window", { prompt: vi.fn(() => "continue please") });
  fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("/api/tasks?")) return Response.json(url.includes("archived") ? [] : [{ ...task, lastRun: run }]);
    if (url.startsWith("/api/task-runs?")) return Response.json(page);
    if (url === "/api/tasks/task-a") return Response.json(task);
    if (url === "/api/tasks/task-a/runs") return Response.json([run]);
    if (url === "/api/task-runs/run-a") { if (delayRun) await delayRun; return Response.json(run); }
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
  tasksView = createTasksView(root as unknown as HTMLElement, () => [], async () => {}, vi.fn(), () => currentSession, openRuns, openTask);
  runsView = createRunsView(root as unknown as HTMLElement, vi.fn(), () => currentSession, openRuns, openTask);
  tasksView.show(); await settled();
});
afterEach(() => vi.unstubAllGlobals());

describe("Tasks", () => {
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
  it("shows flat children and attention, preserves filters across keyset pages, toggles probes", async () => {
    run.parentRunId = "parent"; run.pendingDecisionId = "decision"; run.callbackState = "failed"; run.groupCallbackState = "abandoned";
    page.nextCursor = { queuedAt: 1, id: run.id };
    openRuns({ taskId: task.id }); await settled();
    expect(root.text).toContain("Awaiting decision"); expect(root.text).toContain("Callback not delivered (failed)");
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
  it("only offers actual controls and Continue opens the newly created run", async () => {
    openRuns({}, run.id); await settled(); expect(button("Steer")).toBeUndefined(); expect(button("Stop run")).toBeDefined();
    task.action = { type: "agent", session: { mode: "fresh", cwd: "/test" }, prompt: "work" };
    run.targetSessionId = "child"; run.state = "succeeded"; runsView.refresh(); await settled();
    expect(button("Stop run")).toBeUndefined(); await click("Continue");
    expect(openRuns).toHaveBeenLastCalledWith({}, "continued-run");
  });
  it("matches the actual unresolved decision and only offers reply to its supervisor", async () => {
    run.pendingDecisionId = "question";
    messages = [{ id: "question", runId: run.id, kind: "decision", toSessionId: "supervisor", fromSessionId: "child", state: "pending", content: "Choose?" } as TaskMessage];
    openRuns({}, run.id); await settled(); expect(button("Reply to decision")).toBeUndefined();
    currentSession = "supervisor"; openRuns({}, run.id); await settled(); expect(button("Reply to decision")).toBeDefined();
    await click("Reply to decision"); expect(fetcher).toHaveBeenCalledWith("/api/task-messages/question/reply", expect.objectContaining({ body: JSON.stringify({ message: "continue please", sourceSessionId: "supervisor" }) }));
  });
  it("links parent, resume and wrapper child, and names the group without a page for it", async () => {
    run.parentRunId = "parent"; run.resumedFromRunId = "prior"; run.groupId = "group"; run.result = { type: "task", runId: "child", result: null };
    openRuns({}, run.id); await settled();
    expect(button("Parent: parent")).toBeDefined(); expect(button("Resumed from: prior")).toBeDefined();
    expect(button("Group: group")).toBeUndefined(); expect(root.text).toContain("Group: group");
    await click("Child result: child"); expect(openRuns).toHaveBeenLastCalledWith({}, "child");
  });
});
