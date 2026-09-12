// Wiring only — no logic lives here. See docs/architecture.md.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PiConfigStore } from "./agent/config.js";
import { normalizeAgentSnapshot } from "./agent/config-sync.js";
import { ConfigSync } from "./config-sync.js";
import { configSyncTask } from "./config-sync-task.js";
import { CredentialStore } from "./agent/credentials.js";
import { IndexedListing } from "./agent/listing.js";
import { PiPackageStore } from "./agent/packages.js";
import { PiAgentFactory } from "./agent/pi.js";
import { defaultBoardsDir, registerBoardRoutes } from "./boards/boards.js";
import { ChannelStore } from "./channels/config.js";
import { createControl } from "./channels/control.js";
import { ConversationStore, resolveConversation } from "./channels/conversations.js";
import { registerChannelRoutes } from "./channels/routes.js";
import { ChannelRuntime } from "./channels/runtime.js";
import { EventHub } from "./core/hub.js";
import { splitSpeaker } from "./core/identity.js";
import { pierDb } from "./db.js";
import { deliverLedger, drainForRestart, RestartLedger } from "./drain.js";
import { surfacePrompt } from "./core/reply.js";
import { Router } from "./core/router.js";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { acquireInstanceLock } from "./lock.js";
import { parseWebParams, runWeb } from "./websearch/run.js";
import { logger } from "./log.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";
import { TaskStore } from "./tasks/store.js";
import { PIER_HOME, pierPath, resolveAgentDir } from "./paths.js";
import { CUSTOM_TOOL_RULES, MANAGED, ManagedTools, normalizeCustomTools, prependPath, writePierShim } from "./tools.js";
import { toolsTask } from "./tools-task.js";
import { Secrets } from "./secrets.js";
import { startUpdate, unitPath, updaterProblem } from "./service.js";
import { SettingsStore } from "./settings.js";
import { currentVersion, startAutoUpdate, UpdateCheck, type UpdateStart } from "./update.js";
import { Vault } from "./vault.js";
import { servePier } from "./socket.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./web/auth.js";
import { registerConfigShareRoute, registerConfigSyncRoutes } from "./web/config-sync.js";
import { PushStore, registerPushRoutes } from "./web/push.js";
import { SessionStateStore } from "./web/session-state.js";
import { createServer } from "./web/server.js";
import { registerVaultRoutes } from "./web/vault.js";

const log = logger("pier");

// Before any SDK call resolves a path, so everything Pi derives from its agent
// dir lands under PIER_HOME. PIER_AGENT_DIR marks the value as ours: a second
// Pier spawned from inside the first inherits it, and an inherited value is a
// leak, not an operator override (paths.ts).
process.env.PI_CODING_AGENT_DIR = resolveAgentDir(process.env);
process.env.PIER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

prependPath(process.env);
writePierShim();

// Before the database and before task recovery, which would mark the running
// instance's queued and active runs interrupted; the port is discovered far too
// late, and a second Pier on another port would never notice at all.
const lock = acquireInstanceLock();
if ("heldBy" in lock) {
  log.error(`another Pier (pid ${lock.heldBy === null ? "unknown" : String(lock.heldBy)}) owns ${PIER_HOME} — refusing to start`);
  process.exit(1);
}
// Every exit path at once: the drain and both shutdowns end in `process.exit`,
// and the crash that skips this is what the stale-claim takeover is for.
process.on("exit", lock.release);

// A schema that cannot be migrated must stop the process before a port is open.
const db = pierDb();

// A setting that silently stops being read is a §5 violation.
for (const stale of ["settings.json", "pins.json", "unread.json"]) {
  if (existsSync(pierPath(stale))) {
    log.warn(`${pierPath(stale)} is no longer read — its value lives in pier.db now; re-enter it in the Console and delete the file`);
  }
}

const settings = new SettingsStore(db);

// Unlocked below: vt mode waits on a human approval, and nothing that needs a
// token may run before the key arrives.
const secrets = new Secrets();
const vault = new Vault(secrets, db);

let tasks: TaskService;
const conversations = new ConversationStore(db);
let resolveIm: (key: ConversationKey) => Promise<AgentSession>;
let channelStore: ChannelStore;
let readyForConfigReload = false;
const piConfig = new PiConfigStore();
// Before anything reads settings.json: a first boot gets Pier's seed file.
await piConfig.seedSettings();
const configSync = new ConfigSync({
  db, settings, config: piConfig, normalizeAgent: normalizeAgentSnapshot,
  reload: () => readyForConfigReload ? reloadInstance() : Promise.resolve(),
});
const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));
const factory = new PiAgentFactory(
  // Getters, read per session open: a Console change reaches the next session
  // without a restart.
  () => surfacePrompt({ boardsDir: defaultBoardsDir(), publicUrl: settings.get().publicUrl }),
  // Documents Pier's own tools, so it loads only inside a Pier session.
  [skillsDir],
  new CredentialStore(db, secrets),
  piConfig,
  () => settings.get().modelMenu,
  () => settings.get(),
  () => settings.get().titleModel,
  // Transcripts carry the speaker header core wrote for the model.
  new IndexedListing(undefined, undefined, (text) => splitSpeaker(text).text),
);
const hub = new EventHub();
const router = new Router(hub, (key) => {
  // Web conversation ids are session ids; an IM id is a chat, resolved through
  // the durable map so a restart does not re-route a group.
  if (key.channelId === "web" || key.channelId === "task") {
    return factory.resume(key.conversationId);
  }
  return resolveIm(key);
}, (key) => conversations.get(key));
const stopEviction = router.startIdleEviction();
tasks = new TaskService(new TaskStore(db), factory, router, hub, {
  modelMenu: () => settings.get().modelMenu,
  systemActions: { "config-sync": (signal) => configSync.sync(signal) },
});
const configurationSync = configSyncTask(tasks, configSync);

const managedTools = new ManagedTools();
const toolsUpdate = toolsTask(tasks);

// Before any route exists: two first flips could otherwise both create a task.
const reconciled = await toolsUpdate.reconcile();
if ("problem" in reconciled) log.error(`tools cannot be managed: ${reconciled.problem}`);

const packages = new PiPackageStore(piConfig, { version: currentVersion(), settings }, [skillsDir]);
// At boot, not lazily: the answer waits for the next Console open (update.ts).
packages.watchUpdates();

channelStore = new ChannelStore(db, vault);
const control = createControl({ router, factory, conversations, store: channelStore });
const channels = new ChannelRuntime(channelStore, router, control);
resolveIm = resolveConversation(
  conversations,
  factory,
  control.launchFor,
  (key, message) => {
    logger("channels").warn(`${key.channelId}:${key.conversationId} ${message}`);
    void channels.notify(key.channelId, key.conversationId, message)
      .catch((err: unknown) => log.error(`could not tell ${key.channelId} about its re-routed session`, err));
  },
);
// Channels connect once tokens are readable; a refused unlock must not take
// down the web surface, which is where the operator repairs it. The chats a
// previous restart cut off are told as soon as channels are up (drain.ts).
const restartLedger = new RestartLedger(db);
const startChannels = async (): Promise<void> => {
  await channels.reload();
  await deliverLedger(restartLedger, (entry) =>
    channels.notify(entry.channelId, entry.conversationId, entry.note))
    .catch((err: unknown) => log.error("restart-note delivery failed", err));
};
/** Adapters re-read their configuration and sessions are let go, so the next
 *  message re-opens them with current skills, extensions, prompts and
 *  credentials. SIGHUP and the Console's Reload are both this call. */
const reloadInstance = async (includeWatched = false): Promise<number> => {
  await channels.reload();
  return router.evictIdle(0, Date.now(), { includeWatched });
};

// Remote outages keep the last local configuration available.
if (configSync.status().enabled) {
  // sync() already logged the cause; this line says what the boot did about it.
  try { await configSync.sync(); }
  catch { log.error("Startup configuration sync failed; using the last local configuration"); }
}
await configurationSync.reconcile();
tasks.start();
readyForConfigReload = true;

void secrets.unlock().then(
  startChannels,
  (err) => log.error("secrets locked — channels not started; unlock from Console → Settings → Security, or repair master.key", err),
);

// Replacing Pier is systemd's job: the oneshot unit snapshots the database,
// installs, then stops and starts the service. Without that unit the Console
// says so instead of offering a button that cannot work.
const updates = new UpdateCheck();
// At boot, not lazily: it puts the answer in the journal of a Pier nobody has
// a browser open on.
void updates.refresh();
// The updater's handover, the SIGUSR2 drain and the teardown must see each
// other, or two paths drain the same Pier and one reopens the gate the other
// needs shut.
let handingOver = false;
let draining = false;
let shuttingDown = false;
const takeWorkAgain = (why: string): void => {
  handingOver = false;
  log.error(`${why} — taking work again`);
  // Not ours to reopen: a restart or the teardown owns the gate now.
  if (draining || shuttingDown) return;
  router.endDrain();
  tasks.unpause();
  // Turns the drain deadline-aborted must not wait for a restart days away (§5).
  void deliverLedger(restartLedger, (entry) =>
    channels.notify(entry.channelId, entry.conversationId, entry.note))
    .catch((err: unknown) => log.error("restart-note delivery failed", err));
};
/** `systemctl start --no-block` returns when the job is queued; the real
 *  outcome is a SIGTERM after a registry download on someone else's network.
 *  Long enough not to reopen the gate mid-install, short enough that a handover
 *  that never happens does not refuse messages all afternoon. */
const HANDOVER_GRACE_MS = 5 * 60_000;
const handOverToUpdater = async (): Promise<UpdateStart> => {
  // The updater's first act is `systemctl stop`, the fast teardown: the gate
  // closes and the drain waits first, as `pier restart` does.
  if (handingOver || draining || shuttingDown) return "busy";
  handingOver = true;
  await drainForRestart({ router, tasks, ledger: restartLedger });
  const started = startUpdate({ say: (message: string) => log.info(message) });
  if (started !== "started") {
    takeWorkAgain(`update not started (${started})`);
    return started;
  }
  // A handover that queues and goes nowhere would leave Pier refusing every
  // message with no way back. Unref'd: must not keep the process up under stop.
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
if (updater) {
  const problem = updaterProblem();
  // At boot, when the operator is looking; the alternative is a restart that
  // fails months from now.
  if (problem) log.warn(`the updater cannot run: ${problem}`);
  startAutoUpdate(updates, {
    enabled: () => settings.get().autoUpdate,
    idle: () => router.busy().length === 0 && tasks.activeRunCount() === 0,
    apply: async () => {
      // A version manager can remove the recorded Node months into an uptime.
      const now = updaterProblem();
      if (now) {
        log.error(`auto-update skipped: ${now}`);
        return "not-installed";
      }
      return handOverToUpdater();
    },
  });
}

const app = new Hono();
// Hono's default handler writes nothing to the log.
app.onError((err, c) => {
  log.error(`${c.req.method} ${c.req.path} failed`, err);
  return c.json({ error: String(err) }, 500);
});
// Before every route: Hono runs middleware in registration order, so a surface
// added later is covered without knowing this exists.
const auth = new AuthStore(db);
registerConfigShareRoute(app, configSync);
app.use("*", requireAuth(auth));
registerAuthRoutes(app, auth);
registerConfigSyncRoutes(app, {
  sync: configSync,
  status: () => ({ ...configurationSync.status(), publicUrl: settings.get().publicUrl }),
  reconcile: configurationSync.reconcile,
  run: configurationSync.run,
});
registerTaskRoutes(app, tasks, { factory, router });
registerChannelRoutes(app, channelStore, channels);
registerVaultRoutes(app, { vault, doctor: () => secrets.doctor() });
registerBoardRoutes(app);
const sessionState = new SessionStateStore(db);
registerPushRoutes(app, {
  store: new PushStore(db, secrets),
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
  packages,
  providers: factory,
  settings,
  // Assembled here: the catalog spawns ubix, which web/ may not.
  catalog: async () => {
    const { tools, customTools } = settings.get();
    return { entries: await managedTools.status(tools, customTools), toolsTaskId: toolsUpdate.id() };
  },
  // A switch is validated against what this Pier *can* switch, never against
  // a catalog whose custom half the request may be rewriting.
  names: MANAGED.map((tool) => tool.name),
  onToolsChanged: toolsUpdate.changed,
  validateCustomTools: (raw: unknown) => {
    const validated = normalizeCustomTools(raw);
    return validated ? { tools: validated } : { error: CUSTOM_TOOL_RULES };
  },
  secrets,
  updates,
  updater,
  onUnlocked: () => void startChannels(),
  reload: () => reloadInstance(true),
  backgroundRuns: (id) => tasks.backgroundRuns(id),
  activeBackgroundRunCounts: () => tasks.activeBackgroundRunCounts(),
  taskSessions: () => tasks.taskSessions(),
  channelOf: (id) => conversations.channelOf(id),
}));

const port = Number(process.env.PORT ?? 3141);
const hostname = process.env.HOST ?? "127.0.0.1";

servePier({
  vault,
  // The deep link an agent's "no secret named X" error carries; loopback when
  // no public URL is set, since nothing in the process can discover one.
  fileUrl: (name) => `${settings.get().publicUrl || `http://127.0.0.1:${String(port)}`}/#/settings/vault?name=${name}`,
  task: (params, callerSessionId) => tasks.handle(params, callerSessionId),
  // Progress and cost go to the log: the CLI's answer is the text alone.
  web: async (params, callerSessionId) => {
    const parsed = parseWebParams(params);
    const note = (text: string): void => log.info(`web ${callerSessionId}: ${text}`);
    const result = await runWeb(parsed, await factory.webContext(router.modelOf(callerSessionId)), note);
    note(`done ${JSON.stringify(result.details)}`);
    return result;
  },
  // Live in the router, or on disk: the same two places a callback target is looked for.
  knows: async (id) => router.stateOf(id) !== undefined || (await factory.find(id)) !== undefined,
});

// Every command a turn runs inherits this env: `NODE_ENV=production` makes an
// agent's `npm install` skip devDependencies, and PORT/HOST would aim its dev
// server at Pier's socket.
for (const leak of ["NODE_ENV", "PORT", "HOST"]) delete process.env[leak];
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  log.info(`workbench on http://${hostname}:${port}`);
  log.info(`pid ${process.pid}, node ${process.version}, home ${PIER_HOME}`);
  // The one path that cannot be guessed from PIER_HOME.
  if (process.env.PI_CODING_AGENT_DIR !== pierPath("pi")) {
    log.info(`agent dir ${process.env.PI_CODING_AGENT_DIR} (PI_CODING_AGENT_DIR)`);
  }
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception, exiting", err);
  process.exit(1); // Node's own default outcome, with the area named
});
// Node's default is to crash; a stray rejection in one adapter's background
// work must not take every session and scheduled task down with it.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason);
});
const shutdown = (stopTasks = true): void => {
  // SIGTERM can land while a drain is finishing.
  if (shuttingDown) return;
  shuttingDown = true;
  // A socket an adapter cannot close must not turn `systemctl restart` into a
  // 90-second wait for SIGKILL.
  setTimeout(() => process.exit(0), 3000).unref();
  stopEviction();
  // The drain path leaves task runs alone: aborting would record them cancelled,
  // when the boot-time interrupted marking is the recovery that was promised.
  if (stopTasks) tasks.stop();
  void channels.stop().finally(() => {
    server.close(() => process.exit(0));
    // Every workbench tab holds an SSE stream open, so `close()` alone would
    // wait out the timer above. (`in`: the served type is a union with HTTP/2.)
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    shutdown();
  });
}
// The slow restart (`pier restart`): drain, then exit for `Restart=always`.
// `on`, not `once`: a second SIGUSR2 with no handler would fall back to Node's
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
// Only under systemd: a foreground `pier serve` keeps SIGHUP's default, dying
// with its terminal instead of surviving as an orphan that holds the port.
if (process.env.INVOCATION_ID) {
  process.on("SIGHUP", () => {
    log.info("SIGHUP received, reloading channels and recycling idle sessions");
    void reloadInstance()
      .then((n) => log.info(`recycled ${String(n)} idle session(s)`))
      .catch((err: unknown) => log.error("reload failed", err));
  });
}
