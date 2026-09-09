// The recover boundary of the task tool: what a caller may read back, and the
// one refusal everything else gets. Service-level behaviour lives in
// service.test.ts; here the host is a stub over a real in-memory store.

import { readFileSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { THINKING_LEVELS } from "../core/types.js";
import { openDb } from "../db.js";
import type { TaskMessenger } from "./messages.js";
import type { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { handleTaskTool, type GroupSummary, type RunSummary } from "./tool.js";
import type { TaskDefinition, TaskGroup, TaskRun } from "./types.js";
import type { TaskDefinitions } from "./definitions.js";

const now = 1_700_000_000_000;

const task: TaskDefinition = {
  id: "t1", kind: "subagent", name: "worker", description: "", enabled: true, archived: false, revision: 1,
  trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd: "/tmp" }, prompt: "Work" },
  callback: { type: "origin" }, timeoutSeconds: 900, nextRunAt: null, creator: "session:s1",
  createdBySessionId: "s1", createdAt: now, updatedAt: now,
};

const run = (id: string, over: Partial<TaskRun> = {}): TaskRun => ({
  id, taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null, rootRunId: id, depth: 0,
  resumedFromRunId: null, triggerSource: "agent", invokedBySessionId: "s1", sourceSessionId: "s1",
  targetSessionId: `session-${id}`, sessionMode: "fresh", callbackSessionId: "s1", background: true,
  callbackState: "delivered", callbackAttempts: 1, callbackError: null, callbackNextAttemptAt: null,
  state: "succeeded", input: null, context: { definition: task }, probe: null, matched: null,
  result: { type: "agent", text: "x".repeat(2500), sessionId: `session-${id}` },
  error: null, skipReason: null, queuedAt: now, startedAt: now, finishedAt: now,
  ...over,
});

const group = (id: string, memberRunIds: string[], over: Partial<TaskGroup> = {}): TaskGroup => ({
  id, join: "all", invokedBySessionId: "s1", callbackSessionId: "s1", memberRunIds, winnerRunId: null,
  createdAt: now, finishedAt: now, callbackState: "delivered", callbackAttempts: 1, callbackError: null,
  callbackNextAttemptAt: null, ...over,
});

/** A store with these rows and a host that only knows how to read them: the
 *  recover branch touches nothing else on the service. */
function rig(runs: TaskRun[], groups: TaskGroup[] = [], decisions = new Map<string, string>()) {
  const db = openDb(":memory:");
  onTestFinished(() => db.close());
  const store = new TaskStore(db);
  store.saveTask(task);
  for (const r of runs) store.saveRun(r);
  for (const g of groups) store.saveGroup(g);
  const host = {
    getRun: (id: string) => {
      const found = store.getRun(id);
      if (!found) throw new Error(`unknown task run: ${id}`);
      return found;
    },
    getGroup: (id: string) => {
      const found = store.getGroup(id);
      if (!found) throw new Error(`unknown task group: ${id}`);
      return { group: found, members: found.memberRunIds.map((m) => store.getRun(m)!) };
    },
    run: (_taskId: string, _input: unknown, _source: string, _parent: null, prov: Partial<TaskRun>) =>
      run("new", { state: "queued", callbackState: null, finishedAt: null, result: null, callbackSessionId: prov.callbackSessionId ?? null, callbackMode: prov.callbackMode }),
  } as unknown as TaskService;
  const definitions = { get: () => task, sessionExists: async () => true } as unknown as TaskDefinitions;
  const messages = { openDecisionId: (runId: string) => decisions.get(runId) ?? null } as unknown as TaskMessenger;
  return (input: Record<string, unknown>) =>
    handleTaskTool(host, definitions, store, messages, input, "s1");
}

const notYet = /not recoverable yet/;

describe("task tool recover", () => {
  it("needs a reason", async () => {
    const tool = rig([run("r1")]);
    await expect(tool({ operation: "recover", run_id: "r1" })).rejects.toThrow(/reason/);
  });

  it("returns a delivered result whole, with no truncation note", async () => {
    const tool = rig([run("r1")]);
    const got = await tool({ operation: "recover", run_id: "r1", reason: "callback text was truncated" }) as RunSummary;
    expect(got.runId).toBe("r1");
    expect(got.result?.type === "agent" && got.result.text.length).toBe(2500);
    expect(got.next).toBeUndefined();
  });

  it("allows abandoned and none callbacks once the run is terminal", async () => {
    const tool = rig([
      run("r1", { callbackState: "abandoned", callbackError: "undeliverable after 8 attempts" }),
      run("r2", { callbackSessionId: null, callbackState: null }),
    ]);
    expect(((await tool({ operation: "recover", run_id: "r1", reason: "callback abandoned" })) as RunSummary).state).toBe("succeeded");
    expect(((await tool({ operation: "recover", run_id: "r2", reason: "launched with none" })) as RunSummary).state).toBe("succeeded");
  });

  it("refuses queued, running, pending and failed with the same words — no state leaks", async () => {
    const tool = rig([
      run("q1", { state: "queued", callbackState: null, finishedAt: null, startedAt: null, result: null }),
      run("r2", { state: "running", callbackState: null, finishedAt: null, result: null }),
      run("p3", { callbackState: "pending" }),
      run("f4", { callbackState: "failed", callbackError: "busy" }),
    ]);
    const errors: string[] = [];
    for (const id of ["q1", "r2", "p3", "f4"]) {
      errors.push(await tool({ operation: "recover", run_id: id, reason: "checking" }).then(() => "resolved", (e: Error) => e.message.replace(`run ${id}`, "run <id>")));
    }
    expect(new Set(errors).size).toBe(1);
    expect(errors[0]).toMatch(notYet);
    for (const word of ["queued", "running", "pending", "failed"]) expect(errors[0]).not.toContain(word);
  });

  it("tells a callback:none caller nothing will be delivered instead of promising a callback", async () => {
    const tool = rig([run("n", { state: "running", callbackSessionId: null, callbackState: null, finishedAt: null, result: null })]);
    await expect(tool({ operation: "recover", run_id: "n", reason: "x" })).rejects.toThrow(/callback none.*cannot wait/);
  });

  it("points a run with an open decision at reply", async () => {
    const tool = rig([run("d", { callbackState: null })], [], new Map([["d", "m1"]]));
    await expect(tool({ operation: "recover", run_id: "d", reason: "x" })).rejects.toThrow(/decision m1; reply/);
  });

  it("checks a member through its group, so a member cannot bypass the group callback", async () => {
    const member = (id: string, over: Partial<TaskRun> = {}) => run(id, { groupId: "g", callbackSessionId: null, callbackState: null, ...over });
    const pending = rig([member("a"), member("b")], [group("g", ["a", "b"], { callbackState: "pending" })]);
    await expect(pending({ operation: "recover", run_id: "a", reason: "x" })).rejects.toThrow(notYet);
    await expect(pending({ operation: "recover", group_id: "g", reason: "x" })).rejects.toThrow(notYet);

    // join:first finishes while the loser is still being cancelled.
    const losing = rig(
      [member("w"), member("l", { state: "running", finishedAt: null, result: null })],
      [group("g", ["w", "l"], { join: "first", winnerRunId: "w" })],
    );
    await expect(losing({ operation: "recover", group_id: "g", reason: "x" })).rejects.toThrow(/recover its winning result with run_id w/);
    expect((await losing({ operation: "recover", run_id: "w", reason: "winner callback was truncated" }) as RunSummary).runId).toBe("w");
    await expect(losing({ operation: "recover", run_id: "l", reason: "x" })).rejects.toThrow(/cannot wait for this member/);

    const asking = rig([member("a"), member("b")], [group("g", ["a", "b"])], new Map([["b", "m2"]]));
    await expect(asking({ operation: "recover", group_id: "g", reason: "x" })).rejects.toThrow(/decision m2/);

    const done = rig([member("a"), member("b")], [group("g", ["a", "b"])]);
    const got = await done({ operation: "recover", group_id: "g", reason: "x" }) as GroupSummary;
    expect(got.members.map((m) => m.runId)).toEqual(["a", "b"]);
    expect(got.members[0]!.result?.type === "agent" && got.members[0]!.result.text).toContain("recover run_id a with a reason");
    expect(((await done({ operation: "recover", run_id: "a", reason: "x" })) as RunSummary).result?.type === "agent").toBe(true);
  });

  it("run receipts say how the result arrives, and none promises nothing", async () => {
    const tool = rig([]);
    const followUp = await tool({ operation: "run", task_id: task.id }) as RunSummary;
    expect(followUp.next).toMatch(/callback message once your turn ends; nothing to query/);
    const steer = await tool({ operation: "run", task_id: task.id, callback: "steer" }) as RunSummary;
    expect(steer.next).toMatch(/interrupts your running turn/);
    const none = await tool({ operation: "run", task_id: task.id, callback: "none" }) as RunSummary;
    expect(none.next).toBe("callback none: the result is not delivered to anyone");
    const remote = await tool({ operation: "run", task_id: task.id, callback_session_id: "other" }) as RunSummary;
    expect(remote.next).toBe("the result is delivered to session other; this session will not receive a callback");
  });

  it("refuses every delivery redirect a subagent or a fan-out cannot honour", async () => {
    // A running child whose target session is the caller: `active` is truthy.
    const child = rig([run("child", { state: "running", targetSessionId: "s1", finishedAt: null, result: null })]);
    await expect(child({ operation: "run", task_id: task.id, callback_session_id: "other" }))
      .rejects.toThrow("subagents cannot redirect callbacks (callback_session_id)");
    await expect(child({ operation: "run", tasks: [{ task_id: task.id }, { task_id: task.id }], callback_session_id: "other" }))
      .rejects.toThrow("subagents cannot redirect callbacks (callback_session_id)");

    const top = rig([]);
    await expect(top({ operation: "run", tasks: [{ task_id: task.id }, { task_id: task.id }], callback_session_id: "other" }))
      .rejects.toThrow("callback_session_id applies to a single run only");
    await expect(top({ operation: "run", task_id: task.id, callback: "none", callback_session_id: "other" }))
      .rejects.toThrow(/callback none and callback_session_id conflict/);
    await expect(top({ operation: "run", task: { action: { type: "agent", session: { mode: "fresh", cwd: "/tmp" }, prompt: "Work" }, callback: { type: "session", sessionId: "other" } } }))
      .rejects.toThrow(/inline task draft cannot set callback/);
  });

  it("does not take task_id", async () => {
    const tool = rig([run("r1")]);
    await expect(tool({ operation: "recover", task_id: task.id, reason: "x" })).rejects.toThrow(/run_id/);
  });

  it("rejects the removed get operation without returning state", async () => {
    const tool = rig([run("r1", { state: "running", callbackState: null, result: null })]);
    await expect(tool({ operation: "get", run_id: "r1" })).rejects.toThrow("unknown task operation");
  });

  it("contact still accepts only progress or decision as reason", async () => {
    const tool = rig([run("child", { state: "running", targetSessionId: "s1", finishedAt: null, result: null })]);
    await expect(tool({ operation: "contact", reason: "recover", message: "hi" })).rejects.toThrow(/progress or decision/);
  });

  // The skill is what the agent acts on; a level added here and not there is a
  // drift no agent can see.
  it("the pier-tasks skill lists every thinking level", () => {
    const skill = readFileSync(new URL("../../skills/pier-tasks/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain(`\`${THINKING_LEVELS.join("/")}\``);
  });
});
