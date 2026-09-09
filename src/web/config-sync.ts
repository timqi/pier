// HTTP presentation of the injected configuration subscription. The sole
// public route is registered before auth; every management action is after it.

import type { Hono } from "hono";
import type { ConfigSync } from "../config-sync.js";
import { logger } from "../log.js";
import type { ConfigSyncStatus } from "./types.js";

const log = logger("config-sync");

export function registerConfigShareRoute(app: Hono, sync: Pick<ConfigSync, "published">): void {
  app.get("/config-sync/:token", async (c) => {
    c.header("cache-control", "no-store");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    if (c.req.method !== "GET") {
      c.header("allow", "GET");
      return c.body(null, 405);
    }
    const token = c.req.param("token");
    if (!/^[a-f0-9]{64}$/.test(token)) return c.json({ error: "not found" }, 404);
    try {
      const published = await sync.published(token);
      if (!published) return c.json({ error: "not found" }, 404);
      c.header("etag", published.etag);
      c.header("x-content-type-options", "nosniff");
      const tags = c.req.header("if-none-match")?.split(",").map((value) => value.trim().replace(/^W\//, ""));
      if (tags?.includes(published.etag) || tags?.includes("*")) return c.body(null, 304);
      c.header("content-type", "application/json; charset=utf-8");
      return c.body(published.body);
    } catch {
      // Never let the app's path logger print a capability URL.
      log.error("Could not export shared configuration");
      return c.json({ error: "Could not export configuration" }, 500);
    }
  });
  // Reject other verbs here so neither auth redirects nor request-path logs
  // can carry this capability to another surface.
  app.all("/config-sync/:token", (c) => {
    c.header("cache-control", "no-store");
    c.header("allow", "GET");
    return c.body(null, 405);
  });
}

export function registerConfigSyncRoutes(app: Hono, deps: {
  sync: ConfigSync;
  status: () => ConfigSyncStatus;
  reconcile: () => Promise<unknown>;
  run: () => Promise<string>;
}): void {
  app.get("/api/config-sync", (c) => {
    c.header("cache-control", "no-store");
    return c.json(deps.status());
  });
  app.post("/api/config-sync", async (c) => {
    c.header("cache-control", "no-store");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") return c.json({ error: "action required" }, 400);
    try {
      let result: string | undefined;
      switch (body.action) {
        case "publish": await deps.sync.publish(); break;
        case "revoke": await deps.sync.revoke(); break;
        case "subscribe": {
          if (typeof body.url !== "string") throw new Error("Source URL required");
          result = await deps.sync.subscribe(body.url);
          break;
        }
        case "pause": await deps.sync.pause(); break;
        case "sync": result = await deps.run(); break;
        default: return c.json({ error: "Unknown configuration sync action" }, 400);
      }
      await deps.reconcile();
      return c.json({ ...deps.status(), ...(result ? { result } : {}) });
    } catch (err) {
      // Application can succeed while reload fails; still reconcile the owned
      // task to the persisted subscription switch in that case.
      try { await deps.reconcile(); }
      catch (reconcile) { log.error("Could not reconcile configuration sync task", reconcile); }
      return c.json({ error: err instanceof Error ? err.message : "Configuration sync failed", status: deps.status() }, 409);
    }
  });
}
