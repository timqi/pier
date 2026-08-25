// Routes about the Pier instance itself — settings, update availability,
// layer-1 secrets control, the browser's error reports. Nothing here touches
// a session; server.ts stays the session/event surface.

import type { Hono } from "hono";
import { logger } from "../log.js";
import type { SecretsMode } from "../secrets.js";
import {
  normalizeModelMenu,
  normalizePublicUrl,
  normalizeTerminalInitCommand,
  type SettingsStore,
} from "../settings.js";
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
    /** Ran after a successful unlock; main.ts starts the channels it held
     *  back. A callback because web/ must not import channels/. */
    onUnlocked?: () => void;
    /** The public URL rides in the prompt a session is opened with, so a live
     *  session still quotes the old one: server.ts recycles the idle ones. */
    onSettingsChanged?: () => void;
  },
): void {
  const { settings, updates, updater = null, secrets, onUnlocked, onSettingsChanged } = deps;
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
  app.get("/api/settings", (c) => c.json(settings.get()));

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
      | { publicUrl?: unknown; modelMenu?: unknown; autoUpdate?: unknown; terminalInitCommand?: unknown }
      | null;
    if (
      !body ||
      (body.publicUrl === undefined && body.modelMenu === undefined &&
        body.autoUpdate === undefined && body.terminalInitCommand === undefined)
    ) {
      return c.json({ error: "publicUrl, modelMenu, autoUpdate or terminalInitCommand required" }, 400);
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") return c.json({ error: "publicUrl must be a string" }, 400);
      const publicUrl = normalizePublicUrl(body.publicUrl);
      if (publicUrl === null) {
        return c.json({ error: "not a URL: expected http(s)://host, no query or fragment" }, 400);
      }
      settings.setPublicUrl(publicUrl);
    }
    if (body.modelMenu !== undefined) {
      const menu = normalizeModelMenu(body.modelMenu);
      if (menu === null) {
        return c.json({ error: "modelMenu must be [{provider, id, note?}] (≤32 entries)" }, 400);
      }
      settings.setModelMenu(menu);
    }
    if (body.autoUpdate !== undefined) {
      if (typeof body.autoUpdate !== "boolean") return c.json({ error: "autoUpdate must be a boolean" }, 400);
      settings.setAutoUpdate(body.autoUpdate);
    }
    if (body.terminalInitCommand !== undefined) {
      const command = normalizeTerminalInitCommand(body.terminalInitCommand);
      if (command === null) {
        return c.json({ error: "terminalInitCommand must be one line of at most 500 characters" }, 400);
      }
      settings.setTerminalInitCommand(command);
    }
    // Only the URL: the model menu is read per picker call, not per session.
    if (body.publicUrl !== undefined) onSettingsChanged?.();
    return c.json(settings.get());
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
