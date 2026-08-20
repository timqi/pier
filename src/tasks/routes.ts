import type { Hono } from "hono";
import type { AgentFactory } from "../core/types.js";
import type { Router } from "../core/router.js";
import { record, requiredString } from "./definitions.js";
import type { TaskService } from "./service.js";

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
    const runs = tasks.recentRuns(200).filter((run) =>
      recent
        ? run.queuedAt >= now - 60 * 60 * 1000
        : run.state === "queued" || run.state === "running",
    );
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
    const messages = tasks.recentMessages(recent ? now - 60 * 60 * 1000 : now - 24 * 60 * 60 * 1000)
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

  app.get("/api/tasks", (c) => {
    const trigger = c.req.query("trigger");
    const state = c.req.query("state");
    const kind = c.req.query("kind");
    let rows = tasks.list();
    // Subagent one-shots are hidden unless explicitly requested via ?kind=subagent.
    rows = kind ? rows.filter((task) => task.kind === kind) : rows.filter((task) => task.kind !== "subagent");
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
      return c.json(tasks.getRun(c.req.param("id")));
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

  app.post("/api/task-runs/wait", async (c) => {
    const body = record(await jsonBody(c.req));
    try {
      if (!Array.isArray(body?.runIds)) throw new Error("runIds required");
      const ids = body.runIds.map((id) => requiredString(id, "run id"));
      return c.json(await tasks.waitForRuns(ids, body.mode === "first" ? "first" : "all"));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
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

  app.post("/api/task-messages/:id/reply", async (c) => {
    const body = record(await jsonBody(c.req));
    try {
      const source = requiredString(body?.sourceSessionId, "sourceSessionId");
      return c.json(await tasks.reply(c.req.param("id"), source, requiredString(body?.message, "message")), 202);
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
      const sessionMode = body?.sessionMode === "fresh" || body?.sessionMode === "fork" ? body.sessionMode : undefined;
      const sourceSessionId = typeof body?.sourceSessionId === "string" && body.sourceSessionId ? body.sourceSessionId : null;
      const task = tasks.get(c.req.param("id"));
      const effectiveMode = task.action.type === "agent" ? sessionMode ?? task.action.session.mode : null;
      if (effectiveMode === "fork" && (!sourceSessionId || !(await tasks.sessionExists(sourceSessionId)))) {
        throw new Error("fork requires a known sourceSessionId");
      }
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
