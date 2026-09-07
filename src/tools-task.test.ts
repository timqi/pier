import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskService } from "./tasks/service.js";
import type { TaskDefinition, TaskDraft } from "./tasks/types.js";
import { toolsTask } from "./tools-task.js";

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("./paths.js", () => ({ PIER_HOME: "/test/pier" }));
vi.mock("./log.js", () => ({ logger: vi.fn(() => log) }));
vi.mock("./tools.js", () => ({ coalescedSync: vi.fn(() => vi.fn()) }));

const built = fileURLToPath(new URL("./cli.js", import.meta.url));
const source = fileURLToPath(new URL("./cli.ts", import.meta.url));
const draft = {
  name: "tools: daily update",
  description: "Installs the CLI tools switched on in Settings → Agent and keeps them current.",
  enabled: true,
  trigger: { type: "cron", expression: "17 4 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
  action: { type: "bash", script: `'${process.execPath}' '${built}' tools sync`, cwd: "/test/pier" },
  callback: { type: "none" },
  timeoutSeconds: 1800,
} satisfies TaskDraft;
const task: TaskDefinition = {
  ...draft,
  id: "owned",
  kind: "task",
  archived: false,
  revision: 7,
  nextRunAt: 100,
  creator: "tools",
  createdBySessionId: null,
  createdAt: 1,
  updatedAt: 2,
};

function rig(owned: TaskDefinition[] = []) {
  const tasks = {
    list: vi.fn<TaskService["list"]>().mockReturnValue(owned),
    create: vi.fn<TaskService["create"]>().mockResolvedValue(task),
    update: vi.fn<TaskService["update"]>().mockResolvedValue(task),
    archive: vi.fn<TaskService["archive"]>().mockReturnValue(task),
  };
  return { tasks, owned: toolsTask(tasks as unknown as TaskService) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
});

describe("tools owned task", () => {
  it("creates the complete definition as its owner and retains the identity", async () => {
    const r = rig();
    expect(r.owned.id()).toBeNull();
    await expect(r.owned.reconcile()).resolves.toEqual({ id: task.id });
    expect(r.tasks.create).toHaveBeenCalledExactlyOnceWith(draft, "tools");
    expect(r.tasks.update).not.toHaveBeenCalled();
    expect(r.owned.id()).toBe(task.id);
    r.tasks.list.mockReturnValue([task]);
    await r.owned.reconcile();
    expect(r.tasks.create).toHaveBeenCalledTimes(1);
    expect(r.tasks.update).not.toHaveBeenCalled();
  });

  it("does not update an unchanged definition or increment its revision", async () => {
    const existing = structuredClone(task);
    const r = rig([existing]);
    await r.owned.reconcile();
    await r.owned.reconcile();
    expect(r.tasks.create).not.toHaveBeenCalled();
    expect(r.tasks.update).not.toHaveBeenCalled();
    expect(r.tasks.archive).not.toHaveBeenCalled();
    expect(existing.revision).toBe(7);
    expect(r.owned.id()).toBe(existing.id);
  });

  it.each<[string, Partial<TaskDefinition>]>([
    ["name", { name: "edited" }],
    ["description", { description: "edited" }],
    ["enabled", { enabled: false }],
    ["trigger type", { trigger: { type: "manual" } }],
    ["cron expression", { trigger: { ...draft.trigger, expression: "0 0 * * *" } }],
    ["cron timezone", { trigger: { ...draft.trigger, timezone: "Pacific/Honolulu" === draft.trigger.timezone ? "UTC" : "Pacific/Honolulu" } }],
    ["action type", { action: { type: "task", taskId: "other" } }],
    ["script", { action: { ...draft.action, script: "echo edited" } }],
    ["cwd", { action: { ...draft.action, cwd: "/edited" } }],
    ["callback", { callback: { type: "origin" } }],
    ["timeoutSeconds", { timeoutSeconds: 1 }],
  ])("repairs drift in %s using the complete draft and owner", async (_field, patch) => {
    const r = rig([{ ...task, ...patch }]);
    await expect(r.owned.reconcile()).resolves.toEqual({ id: task.id });
    expect(r.tasks.update).toHaveBeenCalledExactlyOnceWith(task.id, draft, "tools");
    expect(r.tasks.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "the tools update task was edited — restoring the definition Pier owns",
    );
  });

  it("archives only active owned duplicates and logs each one", async () => {
    const r = rig([
      { ...task, id: "foreign", creator: "http" },
      { ...task, id: "archived", archived: true },
      task,
      { ...task, id: "duplicate-1" },
      { ...task, id: "duplicate-2" },
    ]);
    await expect(r.owned.reconcile()).resolves.toEqual({ id: task.id });
    expect(r.tasks.archive.mock.calls).toEqual([["duplicate-1", "tools"], ["duplicate-2", "tools"]]);
    for (const id of ["duplicate-1", "duplicate-2"]) {
      expect(log.warn).toHaveBeenCalledWith(`archiving a second tools update task (${id})`);
    }
    expect(r.tasks.create).not.toHaveBeenCalled();
    expect(r.tasks.update).not.toHaveBeenCalled();
  });

  it("creates a replacement when only archived or foreign tasks exist", async () => {
    const r = rig([{ ...task, archived: true }, { ...task, id: "foreign", creator: "http" }]);
    await r.owned.reconcile();
    expect(r.tasks.create).toHaveBeenCalledExactlyOnceWith(draft, "tools");
    expect(r.tasks.archive).not.toHaveBeenCalled();
    expect(r.tasks.update).not.toHaveBeenCalled();
  });

  it("builds the source command with tsx when no built CLI exists", async () => {
    vi.mocked(existsSync).mockImplementation((path) => path === source);
    const r = rig();
    await r.owned.reconcile();
    expect(r.tasks.create).toHaveBeenCalledExactlyOnceWith({
      ...draft,
      action: { ...draft.action, script: `'${process.execPath}' --import '${import.meta.resolve("tsx")}' '${source}' tools sync` },
    }, "tools");
  });

  it("refuses without writing a definition when neither CLI exists", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const r = rig();
    await expect(r.owned.reconcile()).resolves.toEqual({ problem: `no CLI to run: neither ${built} nor ${source} exists` });
    expect(r.tasks.list).not.toHaveBeenCalled();
    expect(r.tasks.create).not.toHaveBeenCalled();
    expect(r.tasks.update).not.toHaveBeenCalled();
    expect(r.owned.id()).toBeNull();
  });
});
