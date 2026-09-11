import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import type { VtClient } from "../secrets.js";
import { Vault, type VaultEntry } from "../vault.js";
import { AuthStore, requireAuth } from "./auth.js";
import { registerVaultRoutes } from "./vault.js";

/** A scripted vault: put fails with `failure`; the entries are the table. With
 *  `vt`, the real Vault over that client instead — approve rows need no key. */
function rig(opts: { failure?: string; doctor?: string | Error; vt?: VtClient } = {}) {
  const rows = new Map<string, VaultEntry>();
  const calls: string[] = [];
  const db = openDb(":memory:");
  const locked = { encrypt: () => "", decrypt: () => "", state: "locked" as const, lockedReason: "test" };
  const vault = opts.vt ? new Vault(locked, db, opts.vt) : {
    list: () => [...rows.values()],
    async put(name: string, level: "auto" | "approve", plaintext: string) {
      calls.push(`put ${name} ${level} ${plaintext.length}`);
      if (opts.failure) throw new Error(opts.failure);
      rows.set(name, { name, level, updatedAt: 1 });
    },
    remove: (name: string) => {
      calls.push(`remove ${name}`);
      return rows.delete(name);
    },
  };
  const doctor = async (): Promise<string> => {
    if (opts.doctor instanceof Error) throw opts.doctor;
    return opts.doctor ?? "vt doctor — fine";
  };
  const auth = new AuthStore(db, () => {});
  const cookie = `pier_session=${auth.open("10.0.0.9", "a browser")}`;
  const app = new Hono();
  app.use("*", requireAuth(auth));
  registerVaultRoutes(app, { vault, doctor });
  const send = (method: string, path: string, body?: unknown, signedIn = true) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(signedIn ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, rows, calls, send, vault };
}

describe("/api/vault", () => {
  it("sits behind the Console password", async () => {
    const r = rig();
    expect((await r.send("GET", "/api/vault", undefined, false)).status).toBe(401);
    expect((await r.send("PUT", "/api/vault/A", { level: "auto", value: "x" }, false)).status).toBe(401);
    expect((await r.send("DELETE", "/api/vault/A", undefined, false)).status).toBe(401);
    expect(r.calls).toEqual([]);
  });

  it("lists names and levels, never values", async () => {
    const r = rig();
    r.rows.set("A", { name: "A", level: "auto", updatedAt: 5 });
    const res = await r.send("GET", "/api/vault");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([{ name: "A", level: "auto", updatedAt: 5 }]);
  });

  it("files a secret and answers its row", async () => {
    const r = rig();
    const res = await r.send("PUT", "/api/vault/SLACK_TOKEN", { level: "approve", value: "xoxb-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "SLACK_TOKEN", level: "approve", updatedAt: 1 });
    expect(r.calls).toEqual(["put SLACK_TOKEN approve 6"]);
  });

  it("refuses a bad name, a bad level and an empty value before touching the store", async () => {
    const r = rig();
    const bad = async (path: string, body: unknown) => {
      const res = await r.send("PUT", path, body);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await bad("/api/vault/lower", { level: "auto", value: "x" })).toMatch(/A-Z/);
    expect(await bad("/api/vault/A-B", { level: "auto", value: "x" })).toMatch(/A-Z/);
    expect(await bad("/api/vault/A", { level: "maybe", value: "x" })).toBe("level must be auto or approve");
    expect(await bad("/api/vault/A", { level: "auto", value: "" })).toBe("value required");
    expect(await bad("/api/vault/A", { level: "auto" })).toBe("value required");
    expect(r.calls).toEqual([]);
  });

  it("is 503 with vt doctor's report when an approve row cannot be created", async () => {
    const r = rig({ failure: "spawn vt ENOENT", doctor: new Error("spawn vt ENOENT") });
    const res = await r.send("PUT", "/api/vault/A", { level: "approve", value: "x" });
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("vt could not create the record (spawn vt ENOENT)");
    expect(error).toContain("vt doctor: Error: spawn vt ENOENT");
    expect(error).not.toContain("value");
  });

  it("is 504 after 15s when vt create is still waiting for an approval, and files the row once it comes", async () => {
    vi.useFakeTimers();
    try {
      let approve!: (record: string) => void;
      const vt: VtClient = {
        create: () => new Promise<string>((resolve) => (approve = resolve)),
        read: () => Promise.reject(new Error("not in this test")),
        doctor: async () => "vt doctor — fine",
      };
      const r = rig({ vt });
      const pending = r.send("PUT", "/api/vault/DEPLOY_KEY", { level: "approve", value: "x" });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(r.vault.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({
        error: "vt is waiting for approval of the new record — approve it and retry, or file the name as auto",
      });
      // The put was left running: the approval that comes later still lands.
      approve("vt://late");
      await vi.advanceTimersByTimeAsync(0);
      expect(r.vault.list()).toEqual([{ name: "DEPLOY_KEY", level: "approve", updatedAt: expect.any(Number) }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is 423 when an auto row cannot be sealed because the store is locked", async () => {
    const r = rig({ failure: "secrets locked: unlock() has not run" });
    const res = await r.send("PUT", "/api/vault/A", { level: "auto", value: "x" });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: "secrets locked: unlock() has not run" });
  });

  it("removes a row, and names one it does not have", async () => {
    const r = rig();
    r.rows.set("A", { name: "A", level: "auto", updatedAt: 5 });
    expect((await r.send("DELETE", "/api/vault/A")).status).toBe(204);
    const missing = await r.send("DELETE", "/api/vault/A");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no secret named A" });
    expect(r.calls).toEqual(["remove A", "remove A"]);
  });
});
