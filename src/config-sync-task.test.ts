import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSync } from "./config-sync.js";
import { configSyncTask } from "./config-sync-task.js";
import { normalizeAgentSnapshot } from "./agent/config-sync.js";
import type { AgentConfigSnapshot, AgentFactory } from "./core/types.js";
import { EventHub } from "./core/hub.js";
import { Router } from "./core/router.js";
import { openDb } from "./db.js";
import { SettingsStore } from "./settings.js";
import { TaskService } from "./tasks/service.js";
import { runResultText } from "./tasks/callbacks.js";
import { TaskStore } from "./tasks/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function rig() {
  const db = openDb(":memory:");
  const unused = async (): Promise<never> => { throw new Error("Agent must not run for configuration sync"); };
  const factory: AgentFactory = { create: unused, resume: unused, list: async () => [], find: async () => undefined, availableModels: async () => [] };
  const hub = new EventHub(); const router = new Router(hub, unused);
  const settings = new SettingsStore(db);
  let agent: AgentConfigSnapshot = { files: { "SYSTEM.md": null, "AGENTS.md": null }, providers: {} };
  const download = vi.fn(async () => ({ status: 200 as const, etag: '"one"', body: JSON.stringify({
    schemaVersion: 1, instanceId: "source", agent: { ...agent, files: { "SYSTEM.md": "remote", "AGENTS.md": null } }, modelMenu: [],
  }) }));
  const sync = new ConfigSync({ db, settings, normalizeAgent: normalizeAgentSnapshot, download, reload: async () => {},
    config: { exportSnapshot: async () => structuredClone(agent), applySnapshot: async (next, commit) => {
      const changed = JSON.stringify(agent) !== JSON.stringify(next);
      agent = next; commit?.(changed);
    } },
  });
  const store = new TaskStore(db);
  const tasks = new TaskService(store, factory, router, hub, { modelMenu: () => [], systemActions: { "config-sync": (signal) => sync.sync(signal) } });
  cleanups.push(() => { tasks.stop(); db.close(); });
  const owned = configSyncTask(tasks, sync);
  const enable = async () => {
    const url = "https://source.example/config-sync/token";
    await sync.subscribe(url); await owned.reconcile();
  };
  return { db, store, tasks, sync, owned, enable, download };
}

describe("configuration sync owned task", () => {
  it("creates one hourly task only after subscribing and preserves its identity across reconciliation", async () => {
    const r = rig(); await r.owned.reconcile(); expect(r.tasks.list()).toHaveLength(0);
    await r.enable();
    const task = r.tasks.list()[0]!;
    expect(task).toMatchObject({ creator: "config-sync", enabled: true, trigger: { type: "cron", expression: "23 * * * *" }, action: { type: "system", name: "config-sync" } });
    await Promise.all([r.owned.reconcile(), r.owned.reconcile()]);
    expect(r.tasks.list()).toHaveLength(1);
    expect(r.tasks.list()[0]!.revision).toBe(task.revision);
    const reopened = configSyncTask(r.tasks, r.sync); await reopened.reconcile();
    expect(reopened.status().taskId).toBe(task.id);
  });

  it("follows pause and does not download even if the paused task is invoked by ID", async () => {
    const r = rig(); await r.enable();
    await r.sync.pause(); await r.owned.reconcile();
    const task = r.tasks.get(r.owned.status().taskId!);
    expect(task.enabled).toBe(false); expect(task.nextRunAt).toBeNull();
    r.download.mockClear();
    const run = r.tasks.run(task.id, null, "manual");
    expect(await r.tasks.waitForRun(run.id)).toMatchObject({ state: "succeeded", result: { type: "system", text: "Configuration subscription is paused" } });
    expect(r.download).not.toHaveBeenCalled();
    await expect(r.owned.run()).rejects.toThrow("paused");
    await r.owned.reconcile();
    expect(r.tasks.list()).toHaveLength(1);
    expect(r.owned.status()).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("records deterministic runs and reports download failure through the task history", async () => {
    const r = rig(); await r.enable();
    expect(await r.owned.run()).toContain("unchanged");
    expect(runResultText(r.store.listRuns(r.owned.status().taskId!)[0]!)).toBe("Configuration unchanged (200)");
    r.download.mockRejectedValueOnce(new Error("offline"));
    await expect(r.owned.run()).rejects.toThrow("offline");
    expect(r.store.listRuns(r.owned.status().taskId!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "failed", error: "Error: offline" }),
      expect.objectContaining({ state: "succeeded", result: { type: "system", text: "Configuration unchanged (200)" } }),
    ]));
  });

  it("repairs an old edited definition and archives duplicates without discarding history", async () => {
    const r = rig(); await r.enable();
    const first = r.tasks.get(r.owned.status().taskId!);
    r.store.saveTask({ ...first, name: "edited", enabled: false });
    r.store.saveTask({ ...first, id: "duplicate", createdAt: first.createdAt + 1 });
    await r.owned.reconcile();
    const active = r.tasks.list().filter((task) => !task.archived);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ name: "Configuration sync", enabled: true, creator: "config-sync" });
    expect(r.tasks.list().filter((task) => task.archived)).toHaveLength(1);
  });
});
