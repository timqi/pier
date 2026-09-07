// Real task navigation and HTTP, with a small DOM double like composer.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Element {
  children: (Element | string)[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classList = { add: vi.fn(), remove: vi.fn() };
  className = "";
  value = "";
  scrollTop = 0;
  open = false;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
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
    this.children = [];
    this.append(...children);
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
  h: (...args: Parameters<typeof make>) => make(...args),
  fmtDuration: (ms: number) => `${ms}ms`,
  consoleView: (_root: Element, show: (arg?: string) => void) => {
    const view = { visible: false, show(arg?: string) { view.visible = true; show(arg); }, hide() { view.visible = false; } };
    return view;
  },
}));
vi.mock("./form.js", () => ({
  button: (label: string) => make("button", "", label),
  tabButton: (label: string, active: boolean, click: () => void) => {
    const el = make("button", active ? "active" : "", label); el.onclick = click; return el;
  },
  select: (_options: unknown, value: string) => { const el = new Element("select"); el.value = value; return el; },
}));
vi.mock("./task-editor.js", () => ({ openTaskEditor: vi.fn() }));

import { createTasksView } from "./tasks.js";
let root: Element;
let view: ReturnType<typeof createTasksView>;
const task = {
  id: "task-a", name: "Review", archived: false, enabled: true,
  trigger: { type: "manual" }, action: { type: "bash", cwd: "/test", script: "true" },
  callback: { type: "none" }, timeoutSeconds: 60, revision: 1, creator: "console", nextRunAt: null,
};
const run = { id: "run-a", taskId: task.id, state: "running", queuedAt: 1, startedAt: 2, finishedAt: null, triggerSource: "manual", result: { type: "bash", exitCode: 0, stdout: "result text", stderr: "" }, targetSessionId: null };
let fetcher: ReturnType<typeof vi.fn>;
let failMessages: boolean;
let delayRun: Promise<void> | null;
const settled = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const button = (text: string) => walk(root).find((el) => el.tag === "button" && el.text === text)!;
async function click(text: string) { button(text).onclick!(); await settled(); }
async function enterRun() {
  walk(root).find((el) => el.tag === "tr")!.onclick!();
  await settled();
  walk(root).find((el) => el.tag === "button" && el.text.startsWith("running"))!.onclick!();
  await settled();
}
beforeEach(async () => {
  root = new Element(); failMessages = false; delayRun = null;
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("/api/tasks?")) return Response.json(url.includes("archived") ? [] : [{ ...task, lastRun: run }]);
    if (url === "/api/tasks/task-a") return Response.json(task);
    if (url === "/api/tasks/task-a/runs") return Response.json([run]);
    if (url === "/api/task-runs/run-a") { if (delayRun) await delayRun; return Response.json(run); }
    if (url.endsWith("/messages")) return failMessages ? Response.json({ error: "Ledger failed" }, { status: 500 }) : Response.json([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  view = createTasksView(root as unknown as HTMLElement, () => [], async () => {}, vi.fn(), () => null, vi.fn());
  view.show(); await settled();
});
afterEach(() => vi.unstubAllGlobals());

describe("task navigation", () => {
  it("combines status, type and trigger without treating them as exclusive tabs", async () => {
    const change = async (name: string, value: string) => {
      const select = walk(root).find((el) => el.attrs["aria-label"] === name)!;
      select.value = value; select.onchange!(); await settled();
    };
    await change("Type", "subagent");
    await change("Status", "archived");
    expect(fetcher).toHaveBeenCalledWith("/api/tasks?state=archived&kind=subagent", undefined);
    expect(root.text).toContain("No matching tasks.");
  });

  it("keeps Definition selected after a workspace refresh", async () => {
    walk(root).find((el) => el.tag === "tr")!.onclick!(); await settled();
    await click("Definition");
    view.refresh(); await settled();
    expect(root.text).toContain("Scripttrue");
    expect(button("Definition").className).toBe("active");
  });

  it("keeps the selected run, raw disclosure and scroll after refresh", async () => {
    await enterRun();
    const raw = walk(root).find((el) => el.tag === "details")!;
    expect(raw.open).toBe(false);
    raw.open = true; raw.ontoggle!();
    const pane = root.querySelector("[data-task-detail]")!;
    pane.scrollTop = 140; pane.onscroll!();
    view.refresh(); await settled();
    expect(root.text).toContain("result text");
    expect(walk(root).find((el) => el.tag === "details")!.open).toBe(true);
    expect(root.querySelector("[data-task-detail]")!.scrollTop).toBe(140);
  });

  it("shows a ledger error while keeping the run and return control", async () => {
    failMessages = true;
    await enterRun();
    expect(root.text).toContain("Ledger failed");
    expect(root.text).toContain("result text");
    await click("Runs");
    expect(root.text).not.toContain("Raw record");
    expect(root.text).toContain("running");
  });

  it("does not let a delayed run response replace Definition", async () => {
    let release!: () => void;
    delayRun = new Promise<void>((resolve) => { release = resolve; });
    await enterRun();
    await click("Definition");
    release(); await settled();
    expect(root.text).toContain("Scripttrue");
    expect(root.text).not.toContain("Raw record");
  });

  it("keeps task navigation reachable on refresh failure", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: "Tasks unavailable" }, { status: 500 }));
    view.refresh(); await settled();
    expect(root.text).toContain("Tasks unavailable");
    expect(button("Tasks")).toBeDefined();
  });
});
