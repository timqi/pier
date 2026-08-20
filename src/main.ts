// Wiring only — no logic lives here. See docs/architecture.md.

import { serve } from "@hono/node-server";
import { PiAgentFactory } from "./agent/pi.js";
import { EventHub } from "./core/hub.js";
import { Router } from "./core/router.js";
import { PinStore } from "./web/pins.js";
import { createServer } from "./web/server.js";

const factory = new PiAgentFactory();
const hub = new EventHub();
const router = new Router(hub, (key) => {
  // Web conversation ids ARE session ids; IM channels create sessions lazily.
  if (key.channelId === "web") return factory.resume(key.conversationId);
  return factory.create({ cwd: process.cwd() });
});
const app = createServer({ factory, router, hub, pins: new PinStore() });

const port = Number(process.env.PORT ?? 3141);
serve({ fetch: app.fetch, port }, () => {
  console.log(`pier: workbench on http://localhost:${port}`);
});
