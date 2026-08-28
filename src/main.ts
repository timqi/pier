// Wiring only — no logic lives here. See docs/architecture.md.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PiConfigStore } from "./agent/config.js";
import { CredentialStore } from "./agent/credentials.js";
import { PiAgentFactory } from "./agent/pi.js";
import { defaultBoardsDir, registerBoardRoutes } from "./boards/boards.js";
import { ChannelStore } from "./channels/config.js";
import { createControl } from "./channels/control.js";
import { ConversationStore, resolveConversation } from "./channels/conversations.js";
import { registerChannelRoutes } from "./channels/routes.js";
import { ChannelRuntime } from "./channels/runtime.js";
import { SlackApi } from "./channels/slack-api.js";
import { SlackDirectory } from "./channels/slack-directory.js";
import { handleSlackTool, slackToolAvailable, slackToolSpec } from "./channels/slack-tool.js";
import { parseConversation as parseSlackConversation } from "./channels/slack.js";
import { EventHub } from "./core/hub.js";
import { pierDb } from "./db.js";
import { deliverLedger, drainForRestart, RestartLedger } from "./drain.js";
import { bundledInfo } from "./extensions/index.js";
import { surfacePrompt } from "./core/reply.js";
import { Router } from "./core/router.js";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { logger } from "./log.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";
import { TaskStore } from "./tasks/store.js";
import { isTerminal } from "./tasks/types.js";
import { taskToolSpec } from "./tasks/tool.js";
import { PIER_HOME, pierPath, resolveAgentDir } from "./paths.js";
import {
  coalescedSync,
  CUSTOM_TOOL_RULES,
  ManagedTools,
  normalizeCustomTools,
  prependPath,
  TOOLS_TASK_CREATOR,
} from "./tools.js";
import { Secrets } from "./secrets.js";
import { startUpdate, unitPath, updaterProblem } from "./service.js";
import { SettingsStore } from "./settings.js";
import { startAutoUpdate, UpdateCheck, type UpdateStart } from "./update.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./web/auth.js";
import type { ToolsSyncNote } from "./web/types.js";
import { PushStore, registerPushRoutes } from "./web/push.js";
import { SessionStateStore } from "./web/session-state.js";
import { createServer } from "./web/server.js";
import { attachTerminal } from "./web/terminal.js";

const log = logger("pier");

// Pier owns the Pi runtime dir. Set before any SDK call resolves a path, so
// everything Pi derives from its agent dir (auth.json, models.json, sessions,
// bin) lands under PIER_HOME instead of ~/.pi.
//
// An operator override wins — but only a human's. Everything Pier spawns (the
// Web Terminal, the agent's own shell) inherits this variable, so a second
// Pier started from inside the first with its own PIER_HOME would adopt the
// first one's agent dir and write its sessions, SYSTEM.md and models.json
// there: two instances sharing a directory neither was told to share, and
// PIER_HOME looking like it did nothing. PIER_AGENT_DIR marks the value as
// ours, and a value that is ours is not an override, it is a leak — derive it
// again from this instance's own PIER_HOME.
process.env.PI_CODING_AGENT_DIR = resolveAgentDir(process.env);
process.env.PIER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

// Ahead of everything Pier spawns — sessions, tasks, the Web Terminal all
// inherit this process's env. A tool switched on in the Console is Pier's
// copy at Pier's version, so it goes first, not last.
prependPath(process.env);

// First, and explicitly: every store below shares this one connection, and a
// schema that cannot be migrated must stop the process here — before a port is
// open and before anything has written a row.
const db = pierDb();

// Files earlier versions kept beside the database. Their values live in
// pier.db now, and a setting that silently stops being read is a 5b violation:
// the operator who wrote it deserves to hear that it no longer applies.
for (const stale of ["settings.json", "pins.json", "unread.json"]) {
  if (existsSync(pierPath(stale))) {
    log.warn(`${pierPath(stale)} is no longer read — its value lives in pier.db now; re-enter it in the Console and delete the file`);
  }
}

// One store, two readers: the Console writes the public URL, and every session
// opened after that is told the new one.
const settings = new SettingsStore(db);

// Layer-1 credential encryption (channel tokens today). Constructed here,
// unlocked below: file mode is instant, vt mode waits on a human approval, and
// nothing that needs a token may run before the key arrives.
const secrets = new Secrets();

let tasks: TaskService;
const conversations = new ConversationStore(db);
let resolveIm: (key: ConversationKey) => Promise<AgentSession>;
// Declared before the store exists because the factory is built first; the tool
// only ever runs long after wiring is done.
let channelStore: ChannelStore;
// Shared by the adapter and the tool: a display name is looked up once per
// process, not once per message and again per transcript.
const slackDirectory = new SlackDirectory((m) => logger("slack").warn(m));
const piConfig = new PiConfigStore();
const factory = new PiAgentFactory(
  [
    taskToolSpec((params, callerSessionId) => tasks.tool(params, callerSessionId)),
    slackToolSpec(
      (params, callerSessionId) =>
        handleSlackTool({
          store: channelStore,
          directory: slackDirectory,
          // Rebuilt per call: the Console can change the token underneath us,
          // and a client captured at boot would keep using the old one.
          client: () => {
            const config = channelStore.get("slack");
            return config.token ? new SlackApi(config.token, config.appToken) : null;
          },
          // Which Slack thread this session is answering, so "post here" needs
          // no ids. Looked up per call: the mapping is durable, the session is
          // not.
          here: (sessionId) => {
            const key = router.conversationOf(sessionId);
            if (key?.channelId !== "slack") return null;
            const { channel, threadTs } = parseSlackConversation(key.conversationId);
            return channel && threadTs ? { channel, threadTs } : null;
          },
          log: (m) => logger("slack.tool").warn(m),
        }, params, callerSessionId),
      // No Slack, no schema: an unconfigured tool would sit in every prompt of
      // every session and be able to answer nothing.
      () => slackToolAvailable(channelStore),
    ),
  ],
  // Called per session open, so a setting changed in the Console reaches the
  // next session without a restart.
  () => surfacePrompt({ boardsDir: defaultBoardsDir(), publicUrl: settings.get().publicUrl }),
  // Ships with Pier: documents Pier's own tools, so it loads only inside a
  // Pier session — not in a bare Pi session that has no task tool.
  [fileURLToPath(new URL("../skills", import.meta.url))],
  // Provider credentials live sealed in pier.db; a leftover auth.json is
  // imported on first use and renamed to auth.json.imported.
  new CredentialStore(db, secrets),
  piConfig,
  // Operator pins ride ahead of the curated catalog in every model picker.
  () => settings.get().modelMenu,
  // Bundled extensions the Console switched on; read per session open, so the
  // toggle reaches the next session the same way an edited agent file does.
  () => settings.get().extensions,
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
// An attached session holds a live Pi runtime and its transcript, and nothing
// else ever lets one go: without this, one per conversation ever answered.
const stopEviction = router.startIdleEviction();
tasks = new TaskService(new TaskStore(db), factory, router, hub, {
  modelMenu: () => settings.get().modelMenu,
});
tasks.start();

// The managed CLI tools (src/tools.ts) and the one visible thing that keeps
// them current: an ordinary bash task on an ordinary cron, created here
// because tools.ts may not import tasks/. Its run history *is* the tools
// status surface — the install, the daily update and every failure are runs
// with output, so there is no second place to look (§5b).
const managedTools = new ManagedTools();
/** Which task is Pier's, and the id every managed run goes through. */
let toolsTaskId: string | null = null;

/** POSIX single quotes: `$`, a backtick and a backslash mean things inside
 *  double quotes, and this string is run by bash months from now. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * How this Pier runs `pier tools sync`. Installed, that is the built CLI beside
 * main.js. From a source checkout there is no `cli.js` and node cannot strip
 * types through imports that still say `.js`, so it is the same command under
 * tsx — which is what a source checkout has. Neither available is a refusal
 * with a reason, never a task whose script cannot run.
 */
const toolsSyncScript = (): { script: string } | { problem: string } => {
  const built = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(built)) return { script: `${shellQuote(process.execPath)} ${shellQuote(built)} tools sync` };
  const source = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (!existsSync(source)) return { problem: `no CLI to run: neither ${built} nor ${source} exists` };
  try {
    return {
      script: `${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve("tsx"))}` +
        ` ${shellQuote(source)} tools sync`,
    };
  } catch {
    return { problem: `running from source (${source}) and tsx is not installed — run npm install, or npm run build` };
  }
};

/**
 * The one task Pier owns, brought in line with what it should be.
 *
 * Created once and never retired: a task that comes and goes is a state class
 * of its own (two boots racing to create it, a retirement racing a switch),
 * and the run it would have been retired for already says "no tools switched
 * on". Repaired rather than trusted, because the task routes can edit it and a
 * switch must not silently run somebody's edited script.
 */
const ensureToolsTask = async (): Promise<{ id: string } | { problem: string }> => {
  const command = toolsSyncScript();
  if ("problem" in command) return { problem: command.problem };
  const draft = {
    name: "tools: daily update",
    description: "Installs the CLI tools switched on in Settings → Agent and keeps them current.",
    trigger: {
      type: "cron" as const,
      expression: "17 4 * * *",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
    // PIER_HOME as cwd: the command belongs to the instance, not to a project.
    action: { type: "bash" as const, script: command.script, cwd: PIER_HOME },
    timeoutSeconds: 1800,
  };
  const owned = tasks.list().filter((task) => task.creator === TOOLS_TASK_CREATOR && !task.archived);
  // One per creator. Two would fight over ubix's state lock every night, each
  // reporting the other's run as an overlap.
  for (const extra of owned.slice(1)) {
    log.warn(`archiving a second tools update task (${extra.id})`);
    tasks.archive(extra.id);
  }
  const task = owned[0];
  const canonical = JSON.stringify([draft.name, draft.trigger, draft.action, draft.timeoutSeconds]);
  if (task && JSON.stringify([task.name, task.trigger, task.action, task.timeoutSeconds]) !== canonical) {
    log.warn(`the tools update task was edited — restoring the command Pier owns`);
    await tasks.update(task.id, draft);
  }
  const id = task ? task.id : (await tasks.create(draft, TOOLS_TASK_CREATOR)).id;
  toolsTaskId = id;
  return { id };
};

/** The half of `coalescedSync` (tools.ts, which has the rule and why) that
 *  knows what a task is: start a run, and hand back what to wait for — our own
 *  run, or the one already in flight that made ours a `skipped` row. */
const requestSync = coalescedSync({
  run: () => {
    if (!toolsTaskId) throw new Error("no tools update task to run");
    const mine = tasks.run(toolsTaskId, null, "manual");
    if (!isTerminal(mine.state)) {
      return { started: true, settled: tasks.waitForRun(mine.id).then(() => undefined) };
    }
    const active = tasks.listRuns(toolsTaskId, 5).find((run) => !isTerminal(run.state));
    return { started: false, settled: active ? tasks.waitForRun(active.id).then(() => undefined) : null };
  },
}, (err: unknown) => log.error("the tools sync could not be run", err));

/** A switch was flipped: make sure the task is the one Pier means, then ask
 *  for a sync. Answers with what that switch should say about it. */
const toolsChanged = async (): Promise<ToolsSyncNote> => {
  try {
    const task = await ensureToolsTask();
    if ("problem" in task) {
      log.error(`tools cannot be managed: ${task.problem}`);
      return { state: "refused", reason: task.problem };
    }
    return { state: requestSync().state };
  } catch (err) {
    log.error("the tools update task could not be reconciled", err);
    return { state: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
};

// Before any route exists: two first flips could otherwise both find no task
// and create one each. A failure here is logged, and the next flip retries.
const toolsTask = await ensureToolsTask();
if ("problem" in toolsTask) log.error(`tools cannot be managed: ${toolsTask.problem}`);

channelStore = new ChannelStore(db, secrets);
const control = createControl({ router, factory, conversations, store: channelStore });
const channels = new ChannelRuntime(channelStore, router, control);
resolveIm = resolveConversation(
  conversations,
  factory,
  control.launchFor,
  (message) => logger("channels").warn(message),
);
// Channels connect only once tokens are readable. A refused unlock (vt denial,
// corrupt master.key) must not take the web surface down — it is where the
// operator goes to repair — but it is named loudly, not served as silence.
// Once they are up, the chats a previous restart cut off are told (drain.ts) —
// on this path and on a later Console unlock alike, because a note held back
// by locked secrets must not wait for yet another restart.
const restartLedger = new RestartLedger(db);
const startChannels = async (): Promise<void> => {
  await channels.reload();
  await deliverLedger(restartLedger, (entry) =>
    channels.notify(entry.channelId, entry.conversationId, entry.note))
    .catch((err: unknown) => log.error("restart-note delivery failed", err));
};
/** What "reload" means, in one place: the adapters re-read their configuration
 * and sessions are let go, so the next message re-opens them with the current
 * skills, extensions, prompts and credentials — all applied at attach, none
 * stored in a transcript. SIGHUP (`pier reload`) and the Console's Reload are
 * both this call; `includeWatched` is the only difference, and only because the
 * Console knows a person asked from the session they are looking at. */
const reloadInstance = async (includeWatched = false): Promise<number> => {
  await channels.reload();
  return router.evictIdle(0, Date.now(), { includeWatched });
};

void secrets.unlock().then(
  startChannels,
  (err) => log.error("secrets locked — channels not started; unlock from Console → Settings → Security, or repair master.key", err),
);

// Replacing Pier is systemd's job, not this process's: the oneshot unit stops
// the service, snapshots the database, installs and starts it again. Without
// that unit there is nothing to hand the work to, and the Console says so
// instead of offering a button that cannot work.
const updates = new UpdateCheck();
// Asked once at boot, not lazily on the first page load: a restart is exactly
// when "am I current?" is worth knowing, and it puts the answer in the journal
// of a Pier nobody has a browser open on.
void updates.refresh();
/**
 * Hand over, but not onto a running turn. The updater's first act is
 * `systemctl stop`, i.e. a SIGTERM, which is the *fast* teardown — so anything
 * that started since the idle check would be killed with no note anywhere. The
 * gate closes first and the drain waits, exactly as `pier restart` does,
 * ledger included; only then is the install handed over. A handover that never
 * starts reopens the gate, because a Pier that silently refuses every message
 * forever is worse than the race it was avoiding.
 */
// Shared restart state. The updater's handover, the SIGUSR2 drain (below) and
// the final teardown must see each other: without this, two paths drain the
// same Pier at once, and a failure on one reopens the gate the other still
// needs shut.
let handingOver = false;
let draining = false;
let shuttingDown = false;
const takeWorkAgain = (why: string): void => {
  handingOver = false;
  log.error(`${why} — taking work again`);
  // Not ours to reopen: a SIGUSR2 restart or the teardown owns the gate now,
  // and reopening it would hand new work to a process that is exiting.
  if (draining || shuttingDown) return;
  router.endDrain();
  tasks.unpause();
  // The drain may have deadline-aborted turns into the ledger. Without the
  // restart that was supposed to follow, that debt would wait for one days
  // away (§5b) — so the chats are told now, by the process that cut them off.
  void deliverLedger(restartLedger, (entry) =>
    channels.notify(entry.channelId, entry.conversationId, entry.note))
    .catch((err: unknown) => log.error("restart-note delivery failed", err));
};
/** How long the handover has to actually stop us. `systemctl start --no-block`
 *  returns when the job is *queued*, so "started" is not proof of anything;
 *  the real outcome is a SIGTERM a second or two later. */
const HANDOVER_GRACE_MS = 60_000;
const handOverToUpdater = async (): Promise<UpdateStart> => {
  // One handover at a time, and never on top of a restart: the Console button,
  // the auto-update tick and SIGUSR2 would otherwise drain the same Pier
  // twice, each believing the gate is its own to reopen on failure.
  if (handingOver || draining || shuttingDown) return "busy";
  handingOver = true;
  await drainForRestart({ router, tasks, ledger: restartLedger });
  const started = startUpdate({ say: (message: string) => log.info(message) });
  if (started !== "started") {
    takeWorkAgain(`update not started (${started})`);
    return started;
  }
  // The gate is closed and nothing in this process will open it again, so a
  // handover that queues and then goes nowhere — npm failed, the unit was
  // masked, the job sat behind another — would leave Pier alive and refusing
  // every message with no way back. Unref'd: this must not be what keeps the
  // process up while systemd is trying to stop it.
  setTimeout(() => {
    takeWorkAgain(
      `still running ${String(HANDOVER_GRACE_MS / 1000)}s after handing over — pier-update.service never stopped Pier` +
        ` (check: journalctl --user -u pier-update.service -e)`,
    );
  }, HANDOVER_GRACE_MS).unref();
  return started;
};
const updater = process.platform === "linux" && existsSync(unitPath())
  ? { apply: handOverToUpdater, problem: () => updaterProblem() }
  : null;
// Unattended only when the operator asked for it *and* nothing is running.
if (updater) {
  const problem = updaterProblem();
  // Loudly, at boot: this is the one moment the operator is looking, and the
  // alternative is a restart that fails months from now.
  if (problem) log.warn(`the updater cannot run: ${problem}`);
  startAutoUpdate(updates, {
    enabled: () => settings.get().autoUpdate,
    idle: () => router.busy().length === 0 && tasks.activeRunCount() === 0,
    apply: async () => {
      // Re-checked here, not only at boot: a version manager can remove the
      // recorded Node months into an uptime, and draining for a handover that
      // cannot happen would take the whole instance down with it.
      const now = updaterProblem();
      if (now) {
        log.error(`auto-update skipped: ${now}`);
        return "not-installed";
      }
      return handOverToUpdater();
    },
  });
}

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
const auth = new AuthStore(db);
app.use("*", requireAuth(auth));
registerAuthRoutes(app, auth);
registerTaskRoutes(app, tasks, { factory, router });
registerChannelRoutes(app, channelStore, channels);
registerBoardRoutes(app);
const sessionState = new SessionStateStore(db);
// The workbench's notifications to a browser that is not open. Composed here,
// beside the other surfaces: it consumes the same event stream the web server
// does, and neither one runs the other.
registerPushRoutes(app, {
  store: new PushStore(db),
  hub,
  unread: (id) => sessionState.unread(id),
  channelOf: (id) => router.conversationOf(id)?.channelId,
  summary: (id) => factory.find(id),
  publicUrl: () => settings.get().publicUrl,
});
app.route("/", createServer({
  factory,
  router,
  hub,
  sessions: sessionState,
  config: piConfig,
  providers: factory,
  settings,
  // The catalog is code, so the composition root is where it is read: web/
  // gets names and summaries, not a module that imports the Pi SDK.
  // One list, assembled where both halves are visible: the extensions Pier
  // loads from inside itself and the binaries it installs are the same kind of
  // switch to the person flipping it, and rtk is both.
  catalog: async () => {
    const { extensions, tools, customTools } = settings.get();
    return {
      entries: [...bundledInfo(extensions), ...await managedTools.status(tools, customTools)],
      toolsTaskId,
    };
  },
  onToolsChanged: () => toolsChanged(),
  // The rule lives with the installer; the names the bundled catalog already
  // owns live with the extensions. Only here are both in scope.
  validateCustomTools: (raw: unknown) => {
    const validated = normalizeCustomTools(raw, bundledInfo([]).map((entry) => entry.name));
    return validated ? { tools: validated } : { error: CUSTOM_TOOL_RULES };
  },
  secrets,
  updates,
  updater,
  // Unlocked from the Console: start the channels boot held back.
  onUnlocked: () => void startChannels(),
  reload: () => reloadInstance(true),
  backgroundRuns: (id) => tasks.backgroundRuns(id),
  channelOf: (id) => conversations.channelOf(id),
}));

const port = Number(process.env.PORT ?? 3141);
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  log.info(`workbench on http://${hostname}:${port}`);
  log.info(`pid ${process.pid}, node ${process.version}, home ${PIER_HOME}`);
  // Only when it is not the derived default: an agent dir outside PIER_HOME is
  // the one thing about this process's paths that cannot be guessed from it.
  if (process.env.PI_CODING_AGENT_DIR !== pierPath("pi")) {
    log.info(`agent dir ${process.env.PI_CODING_AGENT_DIR} (PI_CODING_AGENT_DIR)`);
  }
});
// The one WebSocket surface (see web/terminal.ts); `serve` above builds a
// plain node:http server, which is the only shape with an upgrade event.
const terminals = attachTerminal(server as import("node:http").Server, auth, {
  initCommand: () => settings.get().terminalInitCommand,
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
const shutdown = (stopTasks = true): void => {
  // Once: SIGTERM can land while a drain is finishing, and two teardowns
  // racing each other close the same sockets twice.
  if (shuttingDown) return;
  shuttingDown = true;
  // Best-effort, and bounded: a socket an adapter cannot close must not turn
  // `systemctl restart` into a 90-second wait for SIGKILL.
  setTimeout(() => process.exit(0), 3000).unref();
  stopEviction();
  terminals.close(); // no shell outlives the workbench
  // The drain path leaves task runs alone: aborting them here would record
  // them cancelled and race their callbacks against dying channels, when the
  // boot-time interrupted marking is the recovery that was promised.
  if (stopTasks) tasks.stop();
  void channels.stop().finally(() => {
    server.close(() => process.exit(0));
    // Every workbench tab holds an SSE stream open, so `close()` alone would
    // always wait out the timer above. (`in` because the served type is a
    // union with HTTP/2, which has no such method — and no such problem.)
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    shutdown();
  });
}
// The slow restart (`pier restart`): refuse new work, let running turns finish
// — bounded by the drain deadline — then exit for `Restart=always` to bring the
// next process up. SIGTERM above stays the fast path systemd expects. `on`,
// not `once`: a second SIGUSR2 with no handler would fall back to Node's
// default and kill the drain it meant to hurry.
process.on("SIGUSR2", () => {
  if (draining) {
    log.info("SIGUSR2 received again — already draining");
    return;
  }
  draining = true;
  log.info("SIGUSR2 received, draining for restart");
  void drainForRestart({ router, tasks, ledger: restartLedger })
    .catch((err: unknown) => log.error("drain failed — shutting down anyway", err))
    .then(() => shutdown(false));
});
// Reload without a restart (`pier reload`): reloadInstance above, leaving the
// sessions someone is watching alone — nobody asked from a browser here.
// Only under systemd (the CLI signals through systemctl): a foreground `pier
// serve` keeps SIGHUP's default, dying with its terminal instead of surviving
// as an orphan that holds the port.
if (process.env.INVOCATION_ID) {
  process.on("SIGHUP", () => {
    log.info("SIGHUP received, reloading channels and recycling idle sessions");
    void reloadInstance()
      .then((n) => log.info(`recycled ${String(n)} idle session(s)`))
      .catch((err: unknown) => log.error("reload failed", err));
  });
}
