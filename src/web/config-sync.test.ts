import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConfigSync } from "../config-sync.js";
import { normalizeAgentSnapshot } from "../agent/config-sync.js";
import type { AgentConfigSnapshot } from "../core/types.js";
import { openDb } from "../db.js";
import { SettingsStore } from "../settings.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./auth.js";
import { registerConfigShareRoute, registerConfigSyncRoutes } from "./config-sync.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function rig() {
  const db = openDb(":memory:"); cleanups.push(() => db.close());
  const settings = new SettingsStore(db);
  let snapshot: AgentConfigSnapshot = { files: { "SYSTEM.md": "private prompt", "AGENTS.md": null }, providers: {} };
  const sync = new ConfigSync({ db, settings, normalizeAgent: normalizeAgentSnapshot, reload: async () => {},
    config: { exportSnapshot: async () => snapshot, applySnapshot: async (next, commit) => {
      const changed = JSON.stringify(snapshot) !== JSON.stringify(next);
      snapshot = next; commit?.(changed);
    } },
  });
  const app = new Hono();
  const auth = new AuthStore(db, () => {}); auth.setPassword("test-password-only");
  registerConfigShareRoute(app, sync);
  app.use("*", requireAuth(auth)); registerAuthRoutes(app, auth);
  const reconcile = vi.fn(async () => {});
  registerConfigSyncRoutes(app, { sync, status: () => sync.status(), reconcile, run: async () => "unchanged" });
  app.get("/api/private", (c) => c.json({ secret: true }));
  const login = await app.request("/login", { method: "POST", body: new URLSearchParams({ password: "test-password-only" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (action: string, extra = {}) => app.request("/api/config-sync", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }),
  });
  return { app, sync, post, cookie, reconcile };
}

describe("configuration sharing HTTP boundary", () => {
  it("opens only the exact token GET route without storing the sensitive representation", async () => {
    const r = await rig();
    const created = await r.post("publish"); expect(created.status).toBe(200);
    const { publishedPath: path } = await created.json() as { publishedPath: string };
    const response = await r.app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const value = await response.json() as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["agent", "instanceId", "modelMenu", "schemaVersion"]);
    const etag = response.headers.get("etag")!;
    const head = await r.app.request(path, { method: "HEAD" });
    expect(head.status).toBe(405); expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBeNull();
    expect(head.headers.get("allow")).toBe("GET");
    for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const unchanged = await r.app.request(path, { headers: { "if-none-match": validator } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get("etag")).toBe(etag);
    }
    expect((await r.app.request("/api/private")).status).toBe(401);
    expect((await r.app.request("/api/config-sync")).status).toBe(401);
    expect((await r.app.request("/api/config-sync", { method: "POST", body: JSON.stringify({ action: "publish" }) })).status).toBe(401);
    expect((await r.app.request(path, { method: "POST" })).status).toBe(405);
    expect((await r.app.request(`${path}/anything`)).status).not.toBe(200);
  });

  it("does not honor an old ETag after revocation or token rotation", async () => {
    const r = await rig();
    const { publishedPath: path } = await (await r.post("publish")).json() as { publishedPath: string };
    const etag = (await r.app.request(path)).headers.get("etag")!;
    await r.post("publish");
    const invalid = await r.app.request(path, { headers: { "if-none-match": etag } });
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    await r.post("revoke");
    expect(r.sync.status().publishedPath).toBeNull();
  });

  it("keeps management writes behind the existing origin guard", async () => {
    const r = await rig();
    const response = await r.app.request("http://localhost/api/config-sync", {
      method: "POST", headers: { cookie: r.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    });
    expect(response.status).toBe(403);
    expect(r.sync.status().publishedPath).toBeNull();
  });

  it("returns an actionable conflict when a publisher tries to subscribe", async () => {
    const r = await rig(); await r.post("publish");
    const response = await r.post("subscribe", { url: "https://source.example/config-sync/token" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Revoke the sharing link before enabling a configuration subscription",
      status: { enabled: false, publishedPath: expect.any(String) },
    });
  });

  it("validates actions and reconciles even when apply committed but reload failed", async () => {
    const r = await rig();
    expect((await r.post("unknown")).status).toBe(400);
    expect((await r.post("subscribe")).status).toBe(409);
    expect(r.reconcile).toHaveBeenCalled();
    vi.spyOn(r.sync, "subscribe").mockRejectedValueOnce(new Error("Configuration saved, but reload failed"));
    const failed = await r.post("subscribe", { url: "https://source.example" });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: "Configuration saved, but reload failed", status: { enabled: false } });
  });
});
