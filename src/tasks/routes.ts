// The area's HTTP surface. A route names the caller and hands the decision to
// TaskService: policy here would be policy the task tool does not get.

import type { Hono } from "hono";
import type { AgentFactory } from "../core/types.js";
import type { Router } from "../core/router.js";
import { record, requiredString } from "./definitions.js";
import type { TaskService } from "./service.js";
import type { RunQuery, TaskRunState, TaskRun } from "./types.js";

/** Reject malformed filters instead of silently widening a global query. */
function runQuery(params: Record<string, string>): RunQuery {
  const query: RunQuery = {};
  const states: TaskRunState[] = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"];
  const sources: TaskRun["triggerSource"][] = ["manual", "cron", "watch", "agent", "task"];
  if (params.state) {
    if (!states.includes(params.state as TaskRunState)) throw new Error("invalid state");
    query.state = params.state as TaskRunState;
  }
  if (params.source) {
    if (!sources.includes(params.source as TaskRun["triggerSource"])) throw new Error("invalid source");
    query.source = params.source as TaskRun["triggerSource"];
  }
  if (params.taskId) query.taskId = params.taskId;
  for (const key of ["since", "until", "limit"] as const) {
    if (params[key] === undefined) continue;
    const value = Number(params[key]);
    if (!params[key] || !Number.isSafeInteger(value) || value < 0 || (key === "limit" && (value < 1 || value > 200))) throw new Error(`invalid ${key}`);
    query[key] = value;
  }
  if (query.since !== undefined && query.until !== undefined && query.since > query.until) throw new Error("since exceeds until");
  if (params.showUnmatched !== undefined) {
    if (!["true", "false"].includes(params.showUnmatched)) throw new Error("invalid showUnmatched");
    query.showUnmatched = params.showUnmatched === "true";
  }
  if (params.cursor) {
    const cursor: unknown = JSON.parse(params.cursor);
    const value = record(cursor);
    if (!value || !Number.isSafeInteger(value.queuedAt) || Number(value.queuedAt) < 0 || typeof value.id !== "string" || !value.id) throw new Error("invalid cursor");
    query.cursor = { queuedAt: Number(value.queuedAt), id: value.id };
  }
  return query;
}

const jsonBody = async (req: { json(): Promise<unknown> }): Promise<unknown> =>
  req.json().catch(() => null);

export function registerTaskRoutes(
  app: Hono,
  tasks: TaskService,
  activity?: { factory: AgentFactory; router: Router },
): void {
  if (activity) app.get("/api/activity", async (c) => {
    const now = Date.now();
    const recent = c.req.query("scope") === "recent";
    const windowStart = now - 24 * 60 * 60 * 1000;
    const runs = tasks.activityRuns(recent ? windowStart : undefined);
    const listed = await activity.factory.list();
    const byId = new Map(listed.map((session) => [session.id, session]));
    const linkedIds = new Set<string>();
    for (const run of runs) {
      for (const id of [run.invokedBySessionId, run.targetSessionId, run.callbackSessionId]) {
        if (id) linkedIds.add(id);
      }
    }
    for (const session of listed) {
      if (activity.router.stateOf(session.id) === "streaming") linkedIds.add(session.id);
    }
    const messages = tasks.recentMessages(windowStart)
      .filter((message) => runs.some((run) => run.id === message.runId));
    for (const message of messages) {
      if (message.fromSessionId !== "console") linkedIds.add(message.fromSessionId);
      if (message.toSessionId !== "console") linkedIds.add(message.toSessionId);
    }
    return c.json({
      sessions: [...linkedIds].map((id) => {
        const session = byId.get(id);
        return {
          id,
          cwd: session?.cwd ?? "",
          title: session?.title,
          state: activity.router.stateOf(id) ?? "idle",
          stateSince: activity.router.stateSinceOf(id) ?? null,
        };
      }),
      runs,
      messages,
    });
  });

  app.get("/api/task-runs", (c) => {
    try {
      return c.json(tasks.queryRuns(runQuery(c.req.query())));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get("/api/tasks", (c) => {
    const trigger = c.req.query("trigger");
    const state = c.req.query("state");
    const kind = c.req.query("kind");
    let rows = tasks.list();
    // Subagent one-shots are hidden unless explicitly requested via ?kind=subagent.
    rows = rows.filter((task) => task.kind === (kind ?? "task"));
    if (trigger) rows = rows.filter((task) => task.trigger.type === trigger);
    if (state === "archived") rows = rows.filter((task) => task.archived);
    else if (state === "active") rows = rows.filter((task) => !task.archived);
    return c.json(rows.map((task) => ({
      ...task,
      lastRun: tasks.listRuns(task.id, 1)[0] ?? null,
    })));
  });

  app.post("/api/tasks", async (c) => {
    const body = await jsonBody(c.req);
    const runNow = typeof body === "object" && body !== null && "runNow" in body && body.runNow === true;
    const definition = typeof body === "object" && body !== null && "task" in body ? body.task : body;
    try {
      const task = await tasks.create(definition);
      const run = runNow ? tasks.run(task.id) : null;
      return c.json({ task, runId: run?.id ?? null }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get("/api/tasks/:id/runs", (c) => {
    try {
      const limit = Number(c.req.query("limit") ?? 50);
      const offset = Number(c.req.query("offset") ?? 0);
      return c.json(tasks.listRuns(c.req.param("id"), limit, offset));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.get("/api/task-runs/:id", (c) => {
    try {
      return c.json(tasks.getRunView(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.get("/api/task-groups/:id", (c) => {
    try {
      return c.json(tasks.getGroup(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.get("/api/task-runs/:id/messages", (c) => {
    try {
      return c.json(tasks.listMessages(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.post("/api/task-runs/:id/steer", async (c) => {
    const body = record(await jsonBody(c.req));
    try {
      return c.json(await tasks.control(
        c.req.param("id"),
        typeof body?.sourceSessionId === "string" ? body.sourceSessionId : "console",
        body?.mode === "followUp" ? "follow_up" : "steer",
        requiredString(body?.message, "message"),
      ), 202);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/task-runs/:id/resume", async (c) => {
    const body = record(await jsonBody(c.req));
    try {
      const wait = body?.wait === true;
      const source = typeof body?.sourceSessionId === "string" ? body.sourceSessionId : null;
      const run = tasks.resume(c.req.param("id"), requiredString(body?.message, "message"), {
        invokedBySessionId: source,
        callbackSessionId: wait ? null : source,
        background: !wait,
      });
      return c.json(wait ? await tasks.waitForRun(run.id) : run, wait ? 200 : 202);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/task-runs/:id/cancel", (c) => {
    try {
      return c.json(tasks.cancel(c.req.param("id")), 202);
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    try {
      return c.json(tasks.get(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.patch("/api/tasks/:id", async (c) => {
    try {
      return c.json(await tasks.update(c.req.param("id"), await jsonBody(c.req)));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/tasks/:id/run", async (c) => {
    const body = record(await jsonBody(c.req));
    const input = body && "input" in body ? body.input : null;
    try {
      // Dropping an unsupported override would run the definition's own policy
      // instead — on a reuse definition, work injected into a live session.
      if (body?.sessionMode !== undefined && body.sessionMode !== "fresh") {
        throw new Error(`unsupported sessionMode: ${String(body.sessionMode)}`);
      }
      const sessionMode = body?.sessionMode;
      const sourceSessionId = typeof body?.sourceSessionId === "string" && body.sourceSessionId ? body.sourceSessionId : null;
      const task = tasks.get(c.req.param("id"));
      return c.json({ runId: tasks.run(task.id, input, "manual", null, {
        invokedBySessionId: sourceSessionId,
        sourceSessionId,
        sessionMode,
      }).id }, 202);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/tasks/:id/pause", (c) => {
    try {
      return c.json(tasks.setEnabled(c.req.param("id"), false));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/tasks/:id/resume", (c) => {
    try {
      return c.json(tasks.setEnabled(c.req.param("id"), true));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/tasks/:id/archive", (c) => {
    try {
      return c.json(tasks.archive(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });
}
