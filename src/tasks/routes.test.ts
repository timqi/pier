import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory } from "../core/types.js";
import { fakeSession } from "../core/session.testkit.js";
import { registerTaskRoutes } from "./routes.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskRow, TaskRun } from "./types.js";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-task-routes-"));
  const session = fakeSession();
  const factory = { resume: vi.fn(async () => session) } as unknown as AgentFactory;
  const hub = new EventHub();
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, new Router(hub, () => factory.resume(session.id)), hub, {
    modelMenu: () => [],
    continuous: { chainOf: () => undefined, members: () => [] },
  });
  const app = new Hono();
  registerTaskRoutes(app, service);
  const draft = (name: string, trigger: unknown = { type: "cron", expression: "0 9 * * *", timezone: "UTC" }) => ({
    name, trigger, action: { type: "bash", cwd, script: "echo hi" }, timeoutSeconds: 5,
  });
  return { app, service, store, draft };
}

describe("task routes", () => {
  it("lists current tasks with their last run, not archived ones or subagents", async () => {
    const { app, service, store, draft } = setup();
    const kept = await service.create(draft("daily"));
    const archived = await service.create(draft("old"));
    service.archive(archived.id);
    const run = { id: "r1", taskId: kept.id, state: "failed", callbackState: null, queuedAt: 1, error: "boom" } as unknown as TaskRun;
    store.saveRun(run);
    const rows = (await (await app.request("/api/tasks")).json()) as TaskRow[];
    expect(rows.map((row) => row.name)).toEqual(["daily"]);
    expect(rows[0]?.lastRun).toMatchObject({ id: "r1", error: "boom" });
    expect(await (await app.request(`/api/tasks/${kept.id}/runs`)).json()).toMatchObject([{ id: "r1" }]);
  });

  it("pauses and resumes a scheduled task, clearing and restoring its next run", async () => {
    const { app, service, draft } = setup();
    const task = await service.create(draft("daily"));
    const paused = (await (await app.request(`/api/tasks/${task.id}/pause`, { method: "POST" })).json()) as TaskRow;
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
    const resumed = (await (await app.request(`/api/tasks/${task.id}/resume`, { method: "POST" })).json()) as TaskRow;
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("answers an unknown task with an error, not a crash", async () => {
    const { app } = setup();
    expect((await app.request("/api/tasks/nope/runs")).status).toBe(404);
    const res = await app.request("/api/tasks/nope/pause", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("unknown task") });
  });
});
