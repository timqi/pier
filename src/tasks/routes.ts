// Settings → Tasks' HTTP surface: the list, pause/resume, a task's runs. A
// route names the caller and hands the decision to TaskService: policy here
// would be policy `pier task` does not get.

import type { Hono } from "hono";
import type { TaskService } from "./service.js";
import type { TaskRow } from "./types.js";

const RUNS_LIMIT = 20;

export function registerTaskRoutes(app: Hono, tasks: TaskService): void {
  // Subagent one-shots and archived tasks are history, not something to manage.
  app.get("/api/tasks", (c) =>
    c.json(tasks.list()
      .filter((task) => task.kind === "task" && !task.archived)
      .map((task): TaskRow => ({ ...task, lastRun: tasks.listRuns(task.id, 1)[0] ?? null }))));

  app.get("/api/tasks/:id/runs", (c) => {
    try {
      return c.json(tasks.listRuns(tasks.get(c.req.param("id")).id, RUNS_LIMIT));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  for (const [verb, enabled] of [["pause", false], ["resume", true]] as const) {
    app.post(`/api/tasks/:id/${verb}`, (c) => {
      try {
        return c.json(tasks.setEnabled(c.req.param("id"), enabled));
      } catch (err) {
        return c.json({ error: String(err) }, 400);
      }
    });
  }
}
