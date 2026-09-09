// How a run ends when the process has to be killed: exit code, cancellation,
// timeout, and a bash TERM trap that gets the last word. Real child processes
// and a real clock (`timeoutSeconds` has second granularity), which is why
// these live apart from the rest of the service suite — they are the only
// tests in it that cannot go faster than the seconds they are asserting.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory } from "../core/types.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { openDb } from "../db.js";

/** A bash action never reaches the agent seam; a factory that answered would
 *  hide it if one did. */
const factory: AgentFactory = {
  availableModels: () => Promise.resolve([]),
  create: () => Promise.reject(new Error("no agent session in this suite")),
  resume: () => Promise.reject(new Error("no agent session in this suite")),
  list: () => Promise.resolve([]),
  find: () => Promise.resolve(undefined),
  search: () => Promise.resolve([]),
};

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-task-"));
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume("none"));
  const service = new TaskService(new TaskStore(openDb(":memory:")), factory, router, hub);
  return { cwd, service };
}

const bashDraft = (cwd: string, script: string) => ({
  name: "command",
  trigger: { type: "manual" },
  action: { type: "bash", cwd, script },
  timeoutSeconds: 5,
});

describe("a run that has to be killed", () => {
  it("reports the reason a run stopped: exit code, cancellation or timeout", async () => {
    const { cwd, service } = setup();
    const failing = await service.create({ ...bashDraft(cwd, "echo out; exit 3"), name: "failing" });
    const failed = await service.waitForRun(service.run(failing.id).id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("bash exited 3");
    expect(failed.result).toMatchObject({ type: "bash", exitCode: 3, stdout: "out\n" });

    // A killed child reports `exited null`; the run must still say why.
    const slow = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "cancel-me" });
    const running = service.run(slow.id);
    service.cancel(running.id);
    const cancelled = await service.waitForRun(running.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("cancelled");

    const timing = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "timeout", timeoutSeconds: 1 });
    const timedOut = await service.waitForRun(service.run(timing.id).id);
    expect(timedOut.state).toBe("failed");
    expect(timedOut.error).toBe("task timed out");

    // Only exit 0/1 are watch verdicts; anything else is a broken probe.
    const broken = await service.create({
      ...bashDraft(cwd, "echo action"),
      name: "watch-broken",
      trigger: { type: "watch", cwd, script: "exit 2", intervalSeconds: 60, mode: "repeat" },
    });
    const probeRun = await service.waitForRun(service.run(broken.id).id);
    expect(probeRun.state).toBe("failed");
    expect(probeRun.error).toContain("watch probe exited 2");
  });

  it.each(["cancel", "timeout"] as const)("keeps %s terminal when a bash TERM trap cleans up and exits zero", async (operation) => {
    const { cwd, service } = setup();
    const task = await service.create({
      ...bashDraft(cwd, "trap 'echo cleaned; exit 0' TERM; echo ready > ready; sleep 3"),
      timeoutSeconds: 1,
    });
    const run = service.run(task.id);
    onTestFinished(async () => {
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    if (operation === "cancel") service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({
      state: operation === "timeout" ? "failed" : "cancelled",
      error: operation === "timeout" ? "task timed out" : "cancelled",
      result: { type: "bash", exitCode: 0, stdout: "cleaned\n" },
    });
  });

  it("keeps a requested cancellation when TERM grace crosses the task timeout", async () => {
    const { cwd, service } = setup();
    const task = await service.create({
      // No children, and bounded even if SIGKILL regresses.
      ...bashDraft(cwd, "trap '' TERM; echo ready > ready; while (( SECONDS < 4 )); do :; done"),
      timeoutSeconds: 1,
    });
    const run = service.run(task.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    onTestFinished(async () => {
      clearTimeout(timer);
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    timer = setTimeout(() => service.cancel(run.id), Math.max(0, run.queuedAt + 900 - Date.now()));
    expect(await service.waitForRun(run.id)).toMatchObject({ state: "cancelled", error: "cancelled" });
  });

  it("does not succeed when cancellation leaves a watch probe unmatched", async () => {
    const { cwd, service } = setup();
    const task = await service.create({
      ...bashDraft(cwd, "echo unexpected > action"),
      trigger: {
        type: "watch", cwd, intervalSeconds: 60, mode: "repeat",
        script: "trap 'exit 1' TERM; echo ready > ready; sleep 3",
      },
    });
    const run = service.run(task.id);
    onTestFinished(async () => {
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({
      state: "cancelled", error: "cancelled", matched: false, probe: { exitCode: 1 },
    });
    expect(existsSync(join(cwd, "action"))).toBe(false);
  });
});
