// The recover boundary of the task tool: what a caller may read back, and the
// one refusal everything else gets. Service-level behaviour lives in
// service.test.ts; here the host is a stub over a real in-memory store.

import { readFileSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { THINKING_LEVELS } from "../core/types.js";
import { openDb } from "../db.js";
import type { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { agentTaskTools, handleTaskTool, type GroupSummary, type RunSummary } from "./tool.js";
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
  id, taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null,
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

const menu = [
  { provider: "anthropic", id: "claude-opus-4", thinking: "high", note: "hardest reasoning" },
  { provider: "openai", id: "gpt-5", thinking: "medium", note: "second opinion" },
  { provider: "openai", id: "gpt-5-mini", thinking: "low", note: "cheap bulk" },
];

/** A store with these rows and a host that only knows how to read them: the
 *  recover branch touches nothing else on the service. */
function rig(runs: TaskRun[], groups: TaskGroup[] = []) {
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
    control: async (id: string, _from: string, kind: string, message: string) => ({ id: "m1", runId: id, kind, content: message }),
    models: async () => ({ source: "menu", models: menu }),
    run: (_taskId: string, _input: unknown, _source: string, _parent: null, prov: Partial<TaskRun>) =>
      run("new", { state: "queued", callbackState: null, finishedAt: null, result: null, callbackSessionId: prov.callbackSessionId ?? null, callbackMode: prov.callbackMode }),
    resume: (_id: string, _message: string, prov: Partial<TaskRun>) =>
      run("resumed", { state: "queued", callbackState: null, finishedAt: null, result: null, callbackSessionId: prov.callbackSessionId ?? null, callbackMode: prov.callbackMode }),
  } as unknown as TaskService;
  const created: Record<string, unknown>[] = [];
  const definitions = {
    get: () => task,
    list: () => [],
    sessionExists: async () => true,
    sessionCwd: async () => "/tmp",
    create: async (draft: Record<string, unknown>) => {
      created.push(draft);
      return task;
    },
  } as unknown as TaskDefinitions;
  const tool = (input: Record<string, unknown>) => handleTaskTool(host, definitions, store, input, "s1");
  return Object.assign(tool, { created });
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

  it("refuses every delivery redirect a fan-out cannot honour", async () => {
    const top = rig([]);
    await expect(top({ operation: "run", tasks: [{ task_id: task.id }, { task_id: task.id }], callback_session_id: "other" }))
      .rejects.toThrow("callback_session_id applies to a single run only");
    await expect(top({ operation: "run", task_id: task.id, callback: "none", callback_session_id: "other" }))
      .rejects.toThrow(/callback none and callback_session_id conflict/);
    await expect(top({ operation: "run", task: { action: { type: "agent", session: { mode: "fresh", cwd: "/tmp" }, prompt: "Work" }, callback: { type: "session", sessionId: "other" } } }))
      .rejects.toThrow(/inline task draft cannot set callback/);
  });

  it("a message on a finished run honours its callback options under the same subagent rule as run", async () => {
    const tool = rig([run("r1")]);
    const resumed = async (input: Record<string, unknown>) => (await tool({ operation: "message", run_id: "r1", message: "go on", ...input }) as { run: RunSummary }).run;
    const none = await resumed({ callback: "none" });
    expect(none.callbackSessionId).toBeUndefined();
    expect(none.next).toBe("callback none: the result is not delivered to anyone");
    const remote = await resumed({ callback_session_id: "other" });
    expect(remote.callbackSessionId).toBe("other");
    expect(remote.next).toBe("the result is delivered to session other; this session will not receive a callback");
  });

  // The caller is the run's own session (`targetSessionId: "s1"`), still running.
  const REFUSAL = "a delegated run cannot delegate; ask in your result and let your supervisor run it";
  const live = (id: string, over: Partial<TaskRun> = {}) =>
    run(id, { state: "running", targetSessionId: "s1", callbackState: null, finishedAt: null, result: null, ...over });

  it("a supervised run is refused every operation, save and list included", async () => {
    const own = rig([live("child", { callbackSessionId: "parent" }), run("sibling")]);
    for (const input of [
      { operation: "run", prompt: "Work" },
      { operation: "run", task_id: task.id },
      { operation: "run", tasks: [{ task_id: task.id }, { task_id: task.id }] },
      { operation: "message", run_id: "sibling", message: "go on" },
      { operation: "save", task: { name: "nightly", action: { type: "bash", script: "true", cwd: "/tmp" } } },
      { operation: "list" },
      { operation: "cancel", run_id: "sibling" },
      { operation: "recover", run_id: "sibling", reason: "x" },
    ]) await expect(own(input)).rejects.toThrow(REFUSAL);
    expect(own.created).toEqual([]);

    // A group member has no callback of its own; its group's is the supervisor.
    const member = rig([live("m", { groupId: "g", callbackSessionId: null })], [group("g", ["m"], { callbackState: "pending" })]);
    await expect(member({ operation: "list" })).rejects.toThrow(REFUSAL);
  });

  it("a run nobody waits on may delegate, and a top-level session always may", async () => {
    const scheduled = rig([live("cron", { triggerSource: "cron", invokedBySessionId: null, callbackSessionId: null })]);
    expect(await scheduled({ operation: "list" })).toEqual([]);
    expect((await scheduled({ operation: "run", prompt: "Work" }) as RunSummary).runId).toBe("new");
    const detached = rig([live("m", { groupId: "g", callbackSessionId: null })], [group("g", ["m"], { callbackSessionId: null, callbackState: null })]);
    expect(await detached({ operation: "list" })).toEqual([]);
    // A finished run's session is nobody's turn any more.
    const after = rig([run("done", { targetSessionId: "s1" })]);
    expect(await after({ operation: "list" })).toEqual([]);
  });

  it("ownership is the launching session or the run's own; anyone else is refused", async () => {
    const tool = rig([
      run("mine", { state: "running", callbackState: null, finishedAt: null, result: null }),
      run("self", { state: "running", invokedBySessionId: null, callbackSessionId: null, callbackState: null, targetSessionId: "s1", finishedAt: null, result: null, triggerSource: "cron" }),
      run("theirs", { invokedBySessionId: "s2", callbackSessionId: "s2" }),
    ], [group("g", ["theirs"], { invokedBySessionId: "s2", callbackSessionId: "s2" })]);
    expect(await tool({ operation: "message", run_id: "mine", message: "x" })).toMatchObject({ delivery: "steer" });
    expect(await tool({ operation: "message", run_id: "self", message: "x" })).toMatchObject({ delivery: "steer" });
    await expect(tool({ operation: "message", run_id: "theirs", message: "x" })).rejects.toThrow("session does not own this run");
    await expect(tool({ operation: "cancel", run_id: "theirs" })).rejects.toThrow("session does not own this run");
    await expect(tool({ operation: "cancel", group_id: "g" })).rejects.toThrow("session does not own this run");
  });

  it("message picks steer, follow-up or resume from the run's state and says which", async () => {
    const tool = rig([
      run("live", { state: "running", callbackState: null, finishedAt: null, result: null }),
      run("done"),
    ]);
    expect(await tool({ operation: "message", run_id: "live", message: "stop" }))
      .toEqual({ delivery: "steer", message: { id: "m1", runId: "live", kind: "steer", content: "stop" } });
    expect(await tool({ operation: "message", run_id: "live", message: "then", after: true }))
      .toMatchObject({ delivery: "follow_up", message: { kind: "follow_up" } });
    const resumed = await tool({ operation: "message", run_id: "done", message: "go on", callback: "steer" }) as { delivery: string; run: RunSummary };
    expect(resumed.delivery).toBe("resume");
    expect(resumed.run.callbackMode).toBe("steer");
    expect(resumed.run.next).toMatch(/interrupts your running turn/);
    // Only a resume is a new run with its own callback; on a live run the option would be dropped, so it is refused.
    await expect(tool({ operation: "message", run_id: "live", message: "x", callback: "steer" }))
      .rejects.toThrow("run live is running: callback options apply to a resumed run only");
    await expect(tool({ operation: "message", run_id: "live", message: "x", callback_session_id: "other" }))
      .rejects.toThrow(/callback options apply to a resumed run only/);
    await expect(tool({ operation: "message", run_id: "live" })).rejects.toThrow("message required");
  });

  it("resolves launch.model by name against the menu, defaulting thinking to the pin's", async () => {
    const tool = rig([]);
    const launchOf = async (launch: Record<string, unknown>) => {
      await tool({ operation: "run", prompt: "Work", launch });
      return (tool.created.at(-1)!.action as { launch: unknown }).launch;
    };
    // One hit: id, provider or note, any case.
    expect(await launchOf({ model: "Opus" })).toEqual({ model: { provider: "anthropic", id: "claude-opus-4" }, thinking: "high" });
    expect(await launchOf({ model: "anthropic" })).toEqual({ model: { provider: "anthropic", id: "claude-opus-4" }, thinking: "high" });
    expect(await launchOf({ model: "cheap bulk" })).toEqual({ model: { provider: "openai", id: "gpt-5-mini" }, thinking: "low" });
    // The caller's thinking wins over the pin's.
    expect(await launchOf({ model: "mini", thinking: "off" })).toEqual({ model: { provider: "openai", id: "gpt-5-mini" }, thinking: "off" });
    // An exact provider/id is its pin even where the substring would be ambiguous.
    expect(await launchOf({ model: "openai/gpt-5" })).toEqual({ model: { provider: "openai", id: "gpt-5" }, thinking: "medium" });
    // A provider/id nobody pinned is taken as written, no thinking implied.
    expect(await launchOf({ model: "openrouter/meta/llama-4" })).toEqual({ model: { provider: "openrouter", id: "meta/llama-4" } });
    // Many or none: the lines to pick from, and the run does not start.
    await expect(launchOf({ model: "gpt" })).rejects.toThrow(
      'model "gpt" matches 2 of the menu:\nopenai/gpt-5 · medium — second opinion\nopenai/gpt-5-mini · low — cheap bulk',
    );
    await expect(launchOf({ model: "gemini" })).rejects.toThrow(/model "gemini" matches 0 of the menu:\nanthropic\/claude-opus-4 · high — hardest reasoning\n/);
    // `?` is the menu itself, in place of a run.
    expect(await tool({ operation: "run", prompt: "Work", launch: { model: "?" } })).toEqual({ source: "menu", models: menu });
    // An object passes through as it always did.
    expect(await launchOf({ model: { provider: "x", id: "y" } })).toEqual({ model: { provider: "x", id: "y" } });
    expect(tool.created).toHaveLength(7);
    await expect(tool({ operation: "models" })).rejects.toThrow("unknown task operation");
  });

  it("does not take task_id", async () => {
    const tool = rig([run("r1")]);
    await expect(tool({ operation: "recover", task_id: task.id, reason: "x" })).rejects.toThrow(/run_id/);
  });

  it("rejects the removed operations without returning state", async () => {
    const tool = rig([run("r1", { state: "running", callbackState: null, result: null })]);
    for (const operation of ["get", "steer", "follow_up", "resume", "contact", "reply", "models", "create", "update"]) {
      await expect(tool({ operation, run_id: "r1", message: "x" })).rejects.toThrow("unknown task operation");
    }
  });

  it("a session opens with the task tool while the switch is on, and without it once off", () => {
    let on = true;
    const tools = agentTaskTools(() => on, async () => null);
    expect(tools().map((tool) => tool.name)).toEqual(["task"]);
    on = false;
    expect(tools()).toEqual([]);
    on = true;
    expect(tools()).toHaveLength(1);
  });

  // The skill is what the agent acts on; a level added here and not there is a
  // drift no agent can see.
  it("the pier-tasks skill lists every thinking level", () => {
    const skill = readFileSync(new URL("../../skills/pier-tasks/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain(`\`${THINKING_LEVELS.join("/")}\``);
  });
});
