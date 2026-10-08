// Settings → Tasks and → Boards drawn from their GET answers with the small
// DOM double: a switch writes and redraws from the server, a refusal is said,
// a run's log opens from its row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button as buttonIn, installDom, labelled, walk, type FakeElement } from "./dom.testkit.js";
import { createBoardsPane } from "./boards.js";
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
const board = { slug: "digest", title: "Weekly", description: "", public: false, updatedAt: new Date().toISOString() };
const LIVE = "https://pier-test.pages.dev/digest/";

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

describe("Settings → Boards", () => {
  beforeEach(() => {
    answers["GET /api/boards"] = () => Response.json([board]);
    answers["GET /api/settings"] = () => Response.json({ pagesProject: "pier-test", pagesUrl: "" });
  });
  const href = (link: FakeElement): string => link.getAttribute("href") ?? (link as unknown as { href: string }).href;

  it("links a private board on the operator's prefix, and a live one on Pages", async () => {
    await mount(createBoardsPane());
    const link = walk(root).find((el) => el.localName === "a")!;
    expect(link.textContent).toBe("Weekly");
    expect(href(link)).toBe("/boards/digest/");
    expect(text()).toContain("digest · private");
    expect(text()).not.toContain("checkbox");

    answers["GET /api/boards"] = () => Response.json([{ ...board, public: true, url: LIVE, publishedAt: board.updatedAt }]);
    const pane = createBoardsPane();
    await mount(pane);
    expect(href(walk(pane.el as unknown as FakeElement).find((el) => el.localName === "a")!)).toBe(LIVE);
  });

  it("says each of the six states", async () => {
    const at = board.updatedAt;
    const earlier = new Date(Date.parse(at) - 60_000).toISOString();
    answers["GET /api/boards"] = () => Response.json([
      { ...board, slug: "a" },
      { ...board, slug: "b", public: true, url: LIVE, publishedAt: at },
      { ...board, slug: "c", public: true, url: LIVE, publishedAt: earlier },
      { ...board, slug: "d", public: true },
      { ...board, slug: "e", public: false, url: LIVE, publishedAt: at },
      { ...board, slug: "f", public: true, url: LIVE, publishedAt: at, deleted: true },
    ]);
    await mount(createBoardsPane());
    for (const line of ["a · private", "b · published ·", "c · published · changes unpublished", "d · publish pending", "e · unpublish pending", "f · deleted · still live"]) {
      expect(text()).toContain(line);
    }
  });

  it("stores the Pages project and address through PUT /api/settings", async () => {
    answers["PUT /api/settings"] = () => Response.json({ pagesProject: "pier-g1", pagesUrl: "https://boards.example.com" });
    await mount(createBoardsPane());
    const [project, address] = walk(root).filter((el) => el.localName === "input");
    expect(project!.value).toBe("pier-test");
    project!.value = "pier-g1";
    address!.value = "boards.example.com";
    buttonIn(root, "Save")!.onclick!(new Event("click"));
    await settled();
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body).toBe('{"pages":{"project":"pier-g1","url":"boards.example.com"}}');
    expect(address!.value).toBe("https://boards.example.com");
    expect(text()).toContain("public boards publish to https://boards.example.com/<slug>/");
  });

  it("copies the absolute link from the row's menu", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 }));
    await mount(createBoardsPane());
    labelled(root, "Actions for Weekly")!.onclick!(new Event("click"));
    buttonIn(document.body as unknown as FakeElement, "Copy link")!.onclick!(new Event("click"));
    await settled();
    expect(writeText).toHaveBeenCalledWith("https://pier.test/boards/digest/");
    expect(text()).toContain("Copied digest's link.");
  });

  it("deletes once confirmed, and redraws the list; a live board is said to stay live", async () => {
    answers["DELETE /api/boards/digest"] = () => Response.json({ deleted: "digest" });
    answers["GET /api/boards"] = () => Response.json([{ ...board, public: true, url: LIVE, publishedAt: board.updatedAt }]);
    await mount(createBoardsPane());
    answers["GET /api/boards"] = () => Response.json([]);
    vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 }));
    labelled(root, "Actions for Weekly")!.onclick!(new Event("click"));
    buttonIn(document.body as unknown as FakeElement, /^Delete/)!.onclick!(new Event("click"));
    expect(calls()).not.toContain("DELETE /api/boards/digest");
    buttonIn(document.body as unknown as FakeElement, /^Delete digest/)!.onclick!(new Event("click"));
    await settled();
    expect(text()).toContain("No boards yet");
    expect(text()).toContain(`Deleted digest — the folder is kept as digest.deleted-<time>. Still live at ${LIVE} until an agent runs pier boards publish.`);
  });
});
