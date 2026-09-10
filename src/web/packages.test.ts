import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  PackageError,
  type AgentFactory,
  type Package,
  type PackageErrorReason,
  type PackageRegistry,
  type PackageStore,
} from "../core/types.js";
import { registerPackageRoutes } from "./packages.js";

const PKG: Package = {
  source: "npm:pkg", kind: "npm", scope: "global", version: "1.0.0", installedPath: "/agent/npm/node_modules/pkg",
  updateAvailable: false,
  resources: [{ kind: "extension", name: "a", path: "/agent/npm/node_modules/pkg/extensions/a.ts", enabled: true, state: null }],
};
const REGISTRY: PackageRegistry = { packages: [PKG], checkedAt: null, busy: null };

/** Scripted PackageStore: records calls; a `fail` reason makes every operation throw it. */
function rig(fail?: PackageErrorReason) {
  const calls: string[] = [];
  const refuse = (): never => { throw new PackageError(fail!, `${fail} in test`); };
  const store: PackageStore = {
    list: async (cwd) => { calls.push(`list:${cwd ?? "global"}`); if (fail) refuse(); return REGISTRY; },
    install: async (source) => { calls.push(`install:${source}`); if (fail) refuse(); return PKG; },
    remove: async (source) => { calls.push(`remove:${source}`); if (fail) refuse(); },
    update: async (source) => { calls.push(`update:${source ?? "*"}`); if (fail) refuse(); return [PKG]; },
    setEnabled: async (change) => { calls.push(`set:${JSON.stringify(change)}`); if (fail) refuse(); return PKG.resources[0]!; },
    checkUpdates: async () => { calls.push("check"); if (fail) refuse(); return { ...REGISTRY, checkedAt: "2026-01-01T00:00:00.000Z" }; },
  };
  const factory = { list: async () => [{ id: "s", cwd: "/known", createdAt: 0, modified: 0 }] } as unknown as AgentFactory;
  const written = vi.fn();
  const app = new Hono();
  registerPackageRoutes(app, { factory, packages: store, onConfigWritten: written });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, calls, written, send };
}

describe("/api/packages", () => {
  it("answers the registry, only for a cwd Pi knows", async () => {
    const r = rig();
    const res = await r.app.request("/api/packages");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(REGISTRY);
    expect((await r.app.request("/api/packages?cwd=/known")).status).toBe(200);
    expect((await r.app.request("/api/packages?cwd=/elsewhere")).status).toBe(400);
    expect(r.calls).toEqual(["list:global", "list:/known"]);
  });

  it("installs, removes and updates, recycling idle sessions after each", async () => {
    const r = rig();
    const installed = await r.send("POST", "/api/packages", { source: "npm:pkg" });
    expect(installed.status).toBe(200);
    expect(await installed.json()).toEqual({ package: PKG });
    const removed = await r.send("POST", "/api/packages/remove", { source: "npm:pkg" });
    expect(await removed.json()).toEqual({ ok: true });
    const one = await r.send("POST", "/api/packages/update", { source: "npm:pkg" });
    expect(await one.json()).toEqual({ packages: [PKG] });
    const all = await r.send("POST", "/api/packages/update", {});
    expect(all.status).toBe(200);
    expect(r.calls).toEqual(["install:npm:pkg", "remove:npm:pkg", "update:npm:pkg", "update:*"]);
    expect(r.written).toHaveBeenCalledTimes(4);
  });

  it("checks now and flips a switch", async () => {
    const r = rig();
    const checked = await r.send("POST", "/api/packages/check");
    expect(((await checked.json()) as PackageRegistry).checkedAt).toBe("2026-01-01T00:00:00.000Z");
    const change = { source: "npm:pkg", kind: "extension", path: PKG.resources[0]!.path, enabled: false };
    const flipped = await r.send("PUT", "/api/packages/resource", change);
    expect(flipped.status).toBe(200);
    expect(await flipped.json()).toEqual(PKG.resources[0]);
    expect((await r.send("PUT", "/api/packages/resource", { ...change, cwd: "/known" })).status).toBe(200);
    expect(r.calls).toEqual(["check", `set:${JSON.stringify(change)}`, `set:${JSON.stringify({ ...change, cwd: "/known" })}`]);
    // A check writes nothing; a switch does.
    expect(r.written).toHaveBeenCalledTimes(2);
  });

  it("refuses a malformed body at the boundary, before the seam", async () => {
    const r = rig();
    for (const [path, body] of [
      ["/api/packages", {}], ["/api/packages", { source: 1 }], ["/api/packages", "nope"],
      ["/api/packages/remove", {}], ["/api/packages/update", { source: 2 }],
    ] as const) {
      const res = await r.send("POST", path, body);
      expect(res.status, path).toBe(400);
    }
    for (const body of [
      {}, { source: "x", kind: "theme", path: "/p", enabled: true }, { source: "x", kind: "skill", path: "", enabled: true },
      { source: "x", kind: "skill", path: "/p", enabled: "yes" }, { source: "x", kind: "skill", path: "/p", enabled: true, cwd: 3 },
    ]) {
      expect((await r.send("PUT", "/api/packages/resource", body)).status, JSON.stringify(body)).toBe(400);
    }
    const unknownCwd = await r.send("PUT", "/api/packages/resource", { source: "x", kind: "skill", path: "/p", enabled: true, cwd: "/nope" });
    expect(unknownCwd.status).toBe(400);
    expect(r.calls).toEqual([]);
    expect(r.written).not.toHaveBeenCalled();
  });

  it("maps the seam's reasons to the table's status codes and recycles nothing", async () => {
    const table: [PackageErrorReason, number][] = [["invalid", 400], ["missing", 404], ["busy", 409], ["refused", 409], ["unreachable", 502]];
    for (const [reason, status] of table) {
      const r = rig(reason);
      for (const res of await Promise.all([
        r.app.request("/api/packages"),
        r.send("POST", "/api/packages", { source: "npm:pkg" }),
        r.send("POST", "/api/packages/remove", { source: "npm:pkg" }),
        r.send("POST", "/api/packages/update", {}),
        r.send("POST", "/api/packages/check"),
        r.send("PUT", "/api/packages/resource", { source: "x", kind: "skill", path: "/p", enabled: true }),
      ])) {
        expect(res.status, reason).toBe(status);
        expect(await res.json()).toEqual({ error: `${reason} in test` });
      }
      expect(r.written).not.toHaveBeenCalled();
    }
  });

  it("lets anything that is not a seam error reach the app's error handler", async () => {
    const r = rig();
    const app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerPackageRoutes(app, {
      factory: { list: async () => [] } as unknown as AgentFactory,
      packages: { ...r.app, list: async () => { throw new Error("disk"); } } as unknown as PackageStore,
    });
    expect((await app.request("/api/packages")).status).toBe(500);
  });
});
