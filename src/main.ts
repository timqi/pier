// Wiring only — no logic lives here. See docs/architecture.md.

import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PiConfigStore } from "./agent/config.js";
import { PiAgentFactory } from "./agent/pi.js";
import { registerBoardRoutes } from "./boards/boards.js";
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
import { REPLY_SURFACE_PROMPT } from "./core/reply.js";
import { Router } from "./core/router.js";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";
import { TaskStore } from "./tasks/store.js";
import { taskToolSpec } from "./tasks/tool.js";
import { pierPath } from "./paths.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./web/auth.js";
import { IdSetStore } from "./web/pins.js";
import { createServer } from "./web/server.js";

let tasks: TaskService;
const conversations = new ConversationStore();
let resolveIm: (key: ConversationKey) => Promise<AgentSession>;
// Declared before the store exists because the factory is built first; the tool
// only ever runs long after wiring is done.
let channelStore: ChannelStore;
// Shared by the adapter and the tool: a display name is looked up once per
// process, not once per message and again per transcript.
const slackDirectory = new SlackDirectory((m) => console.warn(`slack: ${m}`));
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
        log: (m) => console.warn(`slack tool: ${m}`),
      }, params, callerSessionId)
    ),
  ],
  REPLY_SURFACE_PROMPT,
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
  (message) => console.warn(`channels: ${message}`),
);
void channels.reload();

// Composition happens here so web/ and tasks/ never import each other.
const app = new Hono();
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
  backgroundRuns: (id) => tasks.backgroundRuns(id),
}));

const port = Number(process.env.PORT ?? 3141);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`pier: workbench on http://${hostname}:${port}`);
});
