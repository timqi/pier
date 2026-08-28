// Routes about the Pier instance itself — settings, update availability,
// layer-1 secrets control, the browser's error reports. Nothing here touches
// a session; server.ts stays the session/event surface.

import type { Hono } from "hono";
import type { CatalogEntry } from "../core/types.js";
import { logger } from "../log.js";
import type { SecretsMode } from "../secrets.js";
import {
  normalizeExtensions,
  normalizeModelMenu,
  normalizePublicUrl,
  normalizeTerminalInitCommand,
  normalizeTools,
  type SettingsStore,
} from "../settings.js";
import { CUSTOM_TOOL_RULES, normalizeCustomTools } from "../tools.js";
import type { UpdateCheck } from "../update.js";

/** How this instance replaces itself, or `null` where nothing supervises it.
 *  Injected so web/ never learns what systemd is — and so the install never
 *  runs as a child of the request that asked for it. */
export interface UpdateApplier {
  /** `busy`: another handover or a restart already owns the gate. */
  apply(): Promise<"started" | "busy" | "not-installed" | "failed">;
  /** Why applying would fail today, checked before it is attempted. A stale
   *  updater is invisible until the update that needed it (§5b). */
  problem(): string | null;
}

/** The slice of Secrets the routes need; injectable so tests never touch disk
 *  or spawn vt. Never exposes key material — state, mode and the locked reason
 *  are all a browser may see. */
export interface SecretsControl {
  readonly state: "locked" | "unlocked";
  readonly mode: SecretsMode | undefined;
  readonly lockedReason: string;
  unlock(): Promise<void>;
  rotateKek(mode?: SecretsMode): Promise<void>;
}

/** Client reports per minute, for the whole server: a browser bug can fire in
 *  a loop, and the journal is shared with everything else Pier says. */
const CLIENT_LOG_PER_MINUTE = 60;

export function registerInstanceRoutes(
  app: Hono,
  deps: {
    settings: SettingsStore;
    /** Whether a newer Pier exists; answered from cache, refreshed in the
     *  background. */
    updates: UpdateCheck;
    /** `null` when no service manager owns this process: the Console then says
     *  so instead of offering a button that cannot work. */
    updater?: UpdateApplier | null;
    secrets: SecretsControl;
    /** Everything with a switch — bundled extensions and managed binaries in
     *  one list — plus the task whose runs install the binaries. Handed over
     *  as data by main.ts: the catalog is code that imports the Pi SDK and
     *  spawns ubix, and web/ may do neither. Absent in tests that do not care;
     *  the Console then shows no switches. */
    catalog?: () => Promise<{ entries: CatalogEntry[]; toolsTaskId: string | null }>;
    /** Ran after a tool set was written, with the new one. Answers with the
     *  reason nothing will happen, or null — the switch that was just flipped
     *  is where that belongs, not only the journal (§5b). */
    onToolsChanged?: (names: string[]) => Promise<string | null>;
    /** Ran after a successful unlock; main.ts starts the channels it held
     *  back. A callback because web/ must not import channels/. */
    onUnlocked?: () => void;
    /** The public URL rides in the prompt a session is opened with, so a live
     *  session still quotes the old one: server.ts recycles the idle ones. */
    onSettingsChanged?: () => void;
  },
): void {
  const {
    settings,
    updates,
    updater = null,
    secrets,
    catalog,
    onUnlocked,
    onSettingsChanged,
    onToolsChanged,
  } = deps;
  const updateLog = logger("update");
  // How long POST /api/update may hold its response open. A busy Pier drains
  // first, which can take minutes, and a response held that long dies at every
  // proxy on the way (principle 7): past this cap the answer is "draining".
  const APPLY_REPLY_CAP_MS = 10_000;

  // The browser's half of the log. A workbench that threw after the response
  // left the server is otherwise invisible here (ui/report.ts) — this is the
  // one route whose entire purpose is to make it visible.
  const clientLog = logger("client");
  let reports: number[] = [];
  app.post("/api/client-log", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      message?: unknown;
      stack?: unknown;
      view?: unknown;
    } | null;
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message required" }, 400);
    }
    const now = Date.now();
    reports = reports.filter((at) => now - at < 60_000);
    if (reports.length >= CLIENT_LOG_PER_MINUTE) return c.body(null, 429);
    reports.push(now);
    const cap = (value: unknown, max: number): string =>
      typeof value === "string" ? value.slice(0, max) : "";
    const where = cap(body.view, 120);
    const stack = cap(body.stack, 2000);
    // One line, ua included: "only on iOS" is the answer half these questions
    // have, and the report is the only place it exists.
    clientLog.warn(
      `${cap(body.message, 500)} [${where || "/"}] ${cap(c.req.header("user-agent"), 160)}` +
        (stack ? `\n${stack}` : ""),
    );
    return c.body(null, 204);
  });

  // Instance settings. The password lives behind its own route (web/auth.ts):
  // it is a credential, and changing it takes the old one.
  // The catalog rides along: one round trip for the whole page, and the
  // switches cannot disagree with the setting they are drawn from. One shape
  // for both the read and the write, or the page reconciles two answers.
  const instanceSettings = async () => {
    const shown = await catalog?.();
    return {
      ...settings.get(),
      catalog: shown?.entries ?? [],
      /** Where the runs are: the install and every daily update is one task's
       *  history, not a second status surface this route invented. */
      toolsTaskId: shown?.toolsTaskId ?? null,
    };
  };

  app.get("/api/settings", async (c) => c.json(await instanceSettings()));

  // What the version badge reads: the two versions, whether this instance can
  // do anything about the gap, and whether it is allowed to do it unattended.
  // `statusNow` so a browser opened seconds after a restart is told the truth
  // rather than "no idea yet".
  app.get("/api/update", async (c) =>
    c.json({
      ...(await updates.statusNow()),
      canApply: updater !== null,
      autoUpdate: settings.get().autoUpdate,
      // Reported whether or not an update is pending: the repair is the same,
      // and finding out at the next restart is finding out too late.
      problem: updater?.problem() ?? null,
    }));

  // Applying. Nothing is installed here: the work is handed to the service
  // manager's own oneshot unit, which stops Pier, backs the database up,
  // installs and starts Pier again — an npm child of this process would be
  // killed by the very restart it is performing.
  app.post("/api/update", async (c) => {
    if (!updater) {
      return c.json({ error: "no service manager owns this Pier — update it with: pier update" }, 409);
    }
    const { current, latest, available } = await updates.statusNow();
    if (!available) {
      return c.json({ error: latest === null ? "the registry could not be reached" : `${current} is the latest` }, 409);
    }
    const problem = updater.problem();
    if (problem !== null) {
      updateLog.error(`update to ${latest} refused: ${problem}`);
      return c.json({ error: problem }, 409);
    }
    const applied = updater.apply().catch((err: unknown): "failed" => {
      updateLog.error("update handover failed", err);
      return "failed";
    });
    const started = await Promise.race([
      applied,
      new Promise<"draining">((resolve) => setTimeout(resolve, APPLY_REPLY_CAP_MS, "draining").unref()),
    ]);
    if (started === "draining") {
      // The handover keeps running behind this response; if it fails later,
      // main.ts's takeWorkAgain reports it and reopens the gate (§5b).
      updateLog.info(`updating to ${latest} on the Console's request — waiting for running work to finish`);
      return c.json({ started: true, draining: true, latest }, 202);
    }
    if (started === "busy") {
      return c.json({ error: "an update or restart is already in progress" }, 409);
    }
    if (started !== "started") {
      updateLog.error(`update to ${latest} refused by the updater: ${started}`);
      return c.json({
        error: started === "not-installed"
          ? "the systemd unit is not installed — run: pier service install"
          : "the updater could not be started; see the journal",
      }, 500);
    }
    updateLog.info(`updating to ${latest} on the Console's request — Pier stops and starts again`);
    return c.json({ started: true, latest });
  });

  // Partial on purpose: each surface sends only the setting it edits, and a
  // malformed field is rejected before anything is written.
  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | {
        publicUrl?: unknown;
        modelMenu?: unknown;
        autoUpdate?: unknown;
        terminalInitCommand?: unknown;
        extensions?: unknown;
        tools?: unknown;
        customTools?: unknown;
      }
      | null;
    const fields = body
      ? [body.publicUrl, body.modelMenu, body.autoUpdate, body.terminalInitCommand, body.extensions, body.tools, body.customTools]
      : [];
    if (!fields.some((v) => v !== undefined)) {
      return c.json({
        error: "publicUrl, modelMenu, autoUpdate, terminalInitCommand, extensions, tools or customTools required",
      }, 400);
    }
    // Everything is validated before anything is written: a request carrying a
    // new custom tool *and* the switch that turns it on must not leave one of
    // the two stored ("never half-handled").
    const writes: (() => void)[] = [];
    const refuse = (error: string) => c.json({ error }, 400);
    if (body?.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") return refuse("publicUrl must be a string");
      const publicUrl = normalizePublicUrl(body.publicUrl);
      if (publicUrl === null) return refuse("not a URL: expected http(s)://host, no query or fragment");
      writes.push(() => settings.setPublicUrl(publicUrl));
    }
    if (body?.modelMenu !== undefined) {
      const menu = normalizeModelMenu(body.modelMenu);
      if (menu === null) return refuse("modelMenu must be [{provider, id, note?}] (≤32 entries)");
      writes.push(() => settings.setModelMenu(menu));
    }
    if (body?.autoUpdate !== undefined) {
      const { autoUpdate } = body;
      if (typeof autoUpdate !== "boolean") return refuse("autoUpdate must be a boolean");
      writes.push(() => settings.setAutoUpdate(autoUpdate));
    }
    if (body?.terminalInitCommand !== undefined) {
      const command = normalizeTerminalInitCommand(body.terminalInitCommand);
      if (command === null) return refuse("terminalInitCommand must be one line of at most 500 characters");
      writes.push(() => settings.setTerminalInitCommand(command));
    }
    if (body?.extensions !== undefined) {
      const names = normalizeExtensions(body.extensions);
      if (names === null) return refuse("extensions must be a list of names (≤32)");
      writes.push(() => settings.setExtensions(names));
    }
    if (body?.customTools !== undefined) {
      const custom = normalizeCustomTools(body.customTools);
      if (custom === null) return refuse(CUSTOM_TOOL_RULES);
      writes.push(() => settings.setCustomTools(custom));
    }
    let tools: string[] | null = null;
    if (body?.tools !== undefined) {
      tools = normalizeTools(body.tools);
      if (tools === null) return refuse("tools must be a list of names (≤32)");
      const names = tools;
      writes.push(() => settings.setTools(names));
    }
    for (const write of writes) write();
    // Stored first, then acted on: the switch shows what was written even when
    // the install cannot start — and then says why, here, rather than leaving
    // "saved" as the last thing anyone was told.
    const toolsProblem = tools ? { toolsProblem: (await onToolsChanged?.(tools)) ?? null } : {};
    // The URL and the extension set are both read when a session opens; the
    // model menu is read per picker call, so it needs no recycle.
    if (body?.publicUrl !== undefined || body?.extensions !== undefined) onSettingsChanged?.();
    return c.json({ ...(await instanceSettings()), ...toolsProblem });
  });

  // Layer-1 key status and control (Console → Settings → Security). The GET
  // is what a locked instance shows; unlock is how it recovers without a
  // restart, and rotate is the only way to change how the KEK is protected.
  const secretsStatus = () => ({
    state: secrets.state,
    mode: secrets.mode ?? null,
    ...(secrets.state === "locked" ? { reason: secrets.lockedReason } : {}),
  });

  app.get("/api/secrets", (c) => c.json(secretsStatus()));

  app.post("/api/secrets/unlock", async (c) => {
    try {
      await secrets.unlock();
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    onUnlocked?.();
    return c.json(secretsStatus());
  });

  app.post("/api/secrets/rotate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    if (body.mode !== undefined && body.mode !== "vt" && body.mode !== "file") {
      return c.json({ error: "mode must be vt or file" }, 400);
    }
    try {
      await secrets.rotateKek(body.mode);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    return c.json(secretsStatus());
  });
}
