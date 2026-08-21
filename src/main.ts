// Wiring only — no logic lives here. See docs/architecture.md.

import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PiConfigStore } from "./agent/config.js";
import { PiAgentFactory } from "./agent/pi.js";
import { EventHub } from "./core/hub.js";
import { REPLY_SURFACE_PROMPT } from "./core/reply.js";
import { Router } from "./core/router.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";
import { TaskStore } from "./tasks/store.js";
import { taskToolSpec } from "./tasks/tool.js";
import { PinStore } from "./web/pins.js";
import { createServer } from "./web/server.js";

let tasks: TaskService;
const factory = new PiAgentFactory(
  [taskToolSpec((params, callerSessionId) => tasks.tool(params, callerSessionId))],
  REPLY_SURFACE_PROMPT,
  // Ships with Pier: documents Pier's own tools, so it loads only inside a
  // Pier session — not in a bare Pi session that has no task tool.
  [fileURLToPath(new URL("../skills", import.meta.url))],
);
const hub = new EventHub();
const router = new Router(hub, (key) => {
  // Web conversation ids ARE session ids; IM channels create sessions lazily.
  if (key.channelId === "web" || key.channelId === "task") {
    return factory.resume(key.conversationId);
  }
  return factory.create({ cwd: process.cwd() });
});
tasks = new TaskService(new TaskStore(), factory, router, hub);
tasks.start();

// Composition happens here so web/ and tasks/ never import each other.
const app = new Hono();
registerTaskRoutes(app, tasks, { factory, router });
app.route("/", createServer({
  factory,
  router,
  hub,
  pins: new PinStore(),
  config: new PiConfigStore(),
  backgroundRuns: (id) => tasks.backgroundRuns(id),
}));

const port = Number(process.env.PORT ?? 3141);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`pier: workbench on http://${hostname}:${port}`);
});
