// Wiring only — no logic lives here. See docs/architecture.md.

import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PiConfigStore } from "./agent/config.js";
import { PiAgentFactory } from "./agent/pi.js";
import { defaultBoardsDir, registerBoardRoutes } from "./boards/boards.js";
import { ChannelStore } from "./channels/config.js";
import { createControl } from "./channels/control.js";
import { ConversationStore, resolveConversation } from "./channels/conversations.js";
import { registerChannelRoutes } from "./channels/routes.js";
import { ChannelRuntime } from "./channels/runtime.js";
import { SlackApi } from "./channels/slack-api.js";
import { SlackDirectory } from "./channels/slack-directory.js";
import { handleSlackTool, slackToolSpec } from "./channels/slack-tool.js";
import { parseConversation as parseSlackConversation } from "./channels/slack.js";
import { EventHub } from "./core/hub.js";
import { surfacePrompt } from "./core/reply.js";
import { Router } from "./core/router.js";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { logger } from "./log.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";
import { TaskStore } from "./tasks/store.js";
import { taskToolSpec } from "./tasks/tool.js";
import { PIER_HOME, pierPath } from "./paths.js";
import { SettingsStore } from "./settings.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./web/auth.js";
import { IdSetStore } from "./web/pins.js";
import { createServer } from "./web/server.js";

const log = logger("pier");

// One store, two readers: the Console writes the public URL, and every session
// opened after that is told the new one.
const settings = new SettingsStore();

let tasks: TaskService;
const conversations = new ConversationStore();
let resolveIm: (key: ConversationKey) => Promise<AgentSession>;
// Declared before the store exists because the factory is built first; the tool
// only ever runs long after wiring is done.
let channelStore: ChannelStore;
// Shared by the adapter and the tool: a display name is looked up once per
// process, not once per message and again per transcript.
const slackDirectory = new SlackDirectory((m) => logger("slack").warn(m));
const factory = new PiAgentFactory(
  [
    taskToolSpec((params, callerSessionId) => tasks.tool(params, callerSessionId)),
    slackToolSpec((params, callerSessionId) =>
      handleSlackTool({
        store: channelStore,
        directory: slackDirectory,
        // Rebuilt per call: the Console can change the token underneath us,
        // and a client captured at boot would keep using the old one.
        client: () => {
          const config = channelStore.get("slack");
          return config.token ? new SlackApi(config.token, config.appToken) : null;
        },
        // Which Slack thread this session is answering, so "post here" needs no
        // ids. Looked up per call: the mapping is durable, the session is not.
        here: (sessionId) => {
          const key = router.conversationOf(sessionId);
          if (key?.channelId !== "slack") return null;
          const { channel, threadTs } = parseSlackConversation(key.conversationId);
          return channel && threadTs ? { channel, threadTs } : null;
        },
        log: (m) => logger("slack.tool").warn(m),
      }, params, callerSessionId)
    ),
  ],
  // Called per session open, so a setting changed in the Console reaches the
  // next session without a restart.
  () => surfacePrompt({ boardsDir: defaultBoardsDir(), publicUrl: settings.get().publicUrl }),
  // Ships with Pier: documents Pier's own tools, so it loads only inside a
  // Pier session — not in a bare Pi session that has no task tool.
  [fileURLToPath(new URL("../skills", import.meta.url))],
);
const hub = new EventHub();
const router = new Router(hub, (key) => {
  // Web conversation ids ARE session ids; an IM conversation id is a chat or a
  // topic, so its session is looked up in the durable map (and created in the
  // cwd the chat is configured for) — a restart must not re-route a group.
  if (key.channelId === "web" || key.channelId === "task") {
    return factory.resume(key.conversationId);
  }
  return resolveIm(key);
});
tasks = new TaskService(new TaskStore(), factory, router, hub);
tasks.start();

channelStore = new ChannelStore();
const control = createControl({ router, factory, conversations, store: channelStore });
const channels = new ChannelRuntime(channelStore, router, control);
resolveIm = resolveConversation(
  conversations,
  factory,
  control.launchFor,
  (message) => logger("channels").warn(message),
);
void channels.reload();

// Composition happens here so web/ and tasks/ never import each other.
const app = new Hono();
// A route that threw would otherwise answer 500 and leave no trace anywhere:
// Hono's default handler writes nothing to the log, so the operator sees a
// failed request in the browser and an empty journal.
app.onError((err, c) => {
  log.error(`${c.req.method} ${c.req.path} failed`, err);
  return c.json({ error: String(err) }, 500);
});
// Before every route on purpose: Hono runs middleware in registration order,
// so a surface added later is covered without knowing this exists. Built
// before the listener: a first run generates and prints its password here.
const auth = new AuthStore();
registerAuthRoutes(app, auth);
app.use("*", requireAuth(auth));
registerTaskRoutes(app, tasks, { factory, router });
registerChannelRoutes(app, channelStore, channels);
registerBoardRoutes(app);
app.route("/", createServer({
  factory,
  router,
  hub,
  pins: new IdSetStore(pierPath("pins.json")),
  unread: new IdSetStore(pierPath("unread.json")),
  config: new PiConfigStore(),
  settings,
  backgroundRuns: (id) => tasks.backgroundRuns(id),
}));

const port = Number(process.env.PORT ?? 3141);
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  log.info(`workbench on http://${hostname}:${port}`);
  log.info(`pid ${process.pid}, node ${process.version}, home ${PIER_HOME}`);
});

// A crash and a clean stop must be distinguishable after the fact, and both
// left nothing behind before this.
process.on("uncaughtException", (err) => {
  log.error("uncaught exception, exiting", err);
  process.exit(1); // Node's own default outcome, with the area named
});
// This one *does* change behaviour: Node's default is to crash. A stray
// rejection in one adapter's background work must not take every session and
// every scheduled task down with it — so it is logged loudly and Pier serves on.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    // Best-effort, and bounded: a socket an adapter cannot close must not turn
    // `systemctl restart` into a 90-second wait for SIGKILL.
    setTimeout(() => process.exit(0), 3000).unref();
    tasks.stop();
    void channels.stop().finally(() => {
      server.close(() => process.exit(0));
      // Every workbench tab holds an SSE stream open, so `close()` alone would
      // always wait out the timer above. (`in` because the served type is a
      // union with HTTP/2, which has no such method — and no such problem.)
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  });
}
