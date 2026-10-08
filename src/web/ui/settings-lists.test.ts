// Settings → Tasks drawn from its GET answers with the small
// DOM double: a switch writes and redraws from the server, a refusal is said,
// a run's log opens from its row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button as buttonIn, installDom, walk, type FakeElement } from "./dom.testkit.js";
import { createTasksPane } from "./tasks.js";

let root: FakeElement;
let fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let answers: Record<string, () => Response>;
const settled = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const text = () => root.textContent;
const checkbox = () => walk(root).find((el) => el.type === "checkbox")!;
const calls = () => fetcher.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);

const task = {
  id: "t1", kind: "task", name: "daily digest", description: "", enabled: true, archived: false,
  trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" }, nextRunAt: 1e12,
  lastRun: { id: "r1", state: "failed", matched: null, queuedAt: 1e12 },
};
const run = {
  id: "r1", state: "failed", matched: null, triggerSource: "cron", queuedAt: 1e12, startedAt: 1e12, finishedAt: 1e12 + 5000,
  error: "exit 1", skipReason: null, callbackError: null, probe: null, targetSessionId: null,
  result: { type: "bash", exitCode: 1, stdout: "partial", stderr: "boom", stdoutTruncated: false, stderrTruncated: false },
};

beforeEach(() => {
  root = installDom().createElement("div");
  answers = {};
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = answers[`${init?.method ?? "GET"} ${url}`];
    if (!answer) throw new Error(`Unexpected request: ${url}`);
    return answer();
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("location", { origin: "https://pier.test" });
});
afterEach(() => vi.unstubAllGlobals());

async function mount(pane: { el: HTMLElement; show(): void }): Promise<void> {
  root.append(pane.el as unknown as FakeElement);
  pane.show();
  await settled();
}

describe("Settings → Tasks", () => {
  beforeEach(() => {
    answers["GET /api/tasks"] = () => Response.json([task]);
    answers["GET /api/tasks/t1/runs"] = () => Response.json([run]);
  });

  it("draws a task with its schedule and last result", async () => {
    await mount(createTasksPane());
    expect(text()).toContain("daily digest");
    expect(text()).toContain("0 9 * * * (UTC)");
    expect(text()).toContain("failed");
    expect(checkbox().checked).toBe(true);
  });

  it("pauses through the API and redraws from the answer", async () => {
    answers["POST /api/tasks/t1/pause"] = () => Response.json({ ...task, enabled: false });
    await mount(createTasksPane());
    answers["GET /api/tasks"] = () => Response.json([{ ...task, enabled: false }]);
    checkbox().checked = false;
    checkbox().onchange!(new Event("change"));
    await settled();
    expect(calls()).toContain("POST /api/tasks/t1/pause");
    expect(checkbox().checked).toBe(false);
    expect(text()).toContain("daily digest paused.");
  });

  it("says why a refused switch flipped back", async () => {
    answers["POST /api/tasks/t1/pause"] = () => Response.json({ error: "Pier's own task" }, { status: 400 });
    await mount(createTasksPane());
    checkbox().checked = false;
    checkbox().onchange!(new Event("change"));
    await settled();
    expect(text()).toContain("Pier's own task");
    expect(checkbox().checked).toBe(true);
  });

  it("opens a run's log from its row", async () => {
    await mount(createTasksPane());
    buttonIn(root, "Runs")!.onclick!(new Event("click"));
    await settled();
    const details = walk(root).find((el) => el.localName === "details")!;
    expect(details.textContent).toContain("5s");
    details.open = true;
    details.ontoggle!(new Event("toggle"));
    expect(details.textContent).toContain("exit 1");
    expect(details.textContent).toContain("partial");
    expect(details.textContent).toContain("boom");
  });
});
