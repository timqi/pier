// Routes about the Pier instance itself — settings, update availability,
// layer-1 secrets control, the browser's error reports. Nothing here touches
// a session; server.ts stays the session/event surface.

import type { Hono } from "hono";
import { logger } from "../log.js";
import type { SecretsMode } from "../secrets.js";
import { normalizeModelMenu, normalizePublicUrl, type SettingsStore } from "../settings.js";
import type { UpdateCheck } from "../update.js";

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
    secrets: SecretsControl;
    /** Ran after a successful unlock; main.ts starts the channels it held
     *  back. A callback because web/ must not import channels/. */
    onUnlocked?: () => void;
    /** The public URL rides in the prompt a session is opened with, so a live
     *  session still quotes the old one: server.ts recycles the idle ones. */
    onSettingsChanged?: () => void;
  },
): void {
  const { settings, updates, secrets, onUnlocked, onSettingsChanged } = deps;

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

  // Read-only on purpose: the workbench says a newer Pier exists, and applying
  // it stays `pier update` in a terminal. An HTTP route that installs packages
  // is a supply-chain surface behind one password.
  app.get("/api/update", (c) => c.json(updates.status()));

  // Partial on purpose: each surface sends only the setting it edits, and a
  // malformed field is rejected before anything is written.
  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | { publicUrl?: unknown; modelMenu?: unknown }
      | null;
    if (!body || (body.publicUrl === undefined && body.modelMenu === undefined)) {
      return c.json({ error: "publicUrl or modelMenu required" }, 400);
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
