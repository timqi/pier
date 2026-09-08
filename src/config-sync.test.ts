import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiConfigStore } from "./agent/config.js";
import { registerConfigShareRoute } from "./web/config-sync.js";
import { normalizeAgentSnapshot } from "./agent/config-sync.js";
import type { AgentConfigSnapshot, AgentConfigSync } from "./core/types.js";
import { ConfigSync, configJson } from "./config-sync.js";
import type { ConfigDownload } from "./config-sync-fetch.js";
import { openDb } from "./db.js";
import { SettingsStore } from "./settings.js";

const SOURCE = "https://source.example/config-sync/token";
const agent = (text = "local"): AgentConfigSnapshot => ({ files: { "SYSTEM.md": text, "AGENTS.md": null }, providers: {} });
const document = (text = "remote") => ({ schemaVersion: 1, instanceId: "other-instance", agent: agent(text), modelMenu: [{ provider: "anthropic", id: "model" }] });
const answer = (text = "remote", etag = '"one"'): ConfigDownload => ({ status: 200, etag, body: JSON.stringify(document(text)) });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function rig() {
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  const settings = new SettingsStore(db);
  let local = agent();
  const apply = vi.fn(async (snapshot: AgentConfigSnapshot, commit?: (changed: boolean) => void) => {
    const before = local;
    local = structuredClone(snapshot);
    try { commit?.(configJson(before) !== configJson(local)); } catch (err) { local = before; throw err; }
  });
  const config: AgentConfigSync = { exportSnapshot: async () => structuredClone(local), applySnapshot: apply };
  const download = vi.fn(async (): Promise<ConfigDownload> => answer());
  const reload = vi.fn(async () => {});
  const deps = { db, settings, config, normalizeAgent: normalizeAgentSnapshot, download, reload };
  const sync = new ConfigSync(deps);
  const enable = () => sync.subscribe(SOURCE);
  const state = (): Record<string, unknown> => JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'configSync'").get() as { value: string }).value) as Record<string, unknown>;
  return { db, settings, config, apply, download, reload, deps, sync, enable, state, local: () => local, edit: (text: string) => { local = agent(text); } };
}

describe("configuration subscription", () => {
  it("downloads on enable, persists state/ETag, and keeps unrelated settings", async () => {
    const r = rig();
    r.settings.setPublicUrl("https://local.example");
    r.settings.setExtensions(["web"]);
    expect(r.sync.status().enabled).toBe(false);
    await r.enable();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get()).toMatchObject({ publicUrl: "https://local.example", extensions: ["web"], modelMenu: document().modelMenu });
    expect(r.reload).toHaveBeenCalledTimes(1);
    expect(new ConfigSync(r.deps).status()).toMatchObject({ enabled: true, sourceUrl: SOURCE });
    expect(r.state().etag).toBe('"one"');
  });

  it("304 and identical 200 never write files or reload, including after restart", async () => {
    const r = rig(); await r.enable();
    const restarted = new ConfigSync(r.deps);
    r.apply.mockClear(); r.reload.mockClear();
    r.download.mockResolvedValueOnce({ status: 304, etag: '"untrusted"', body: "" });
    expect(await restarted.sync()).toContain("304");
    expect(r.download).toHaveBeenLastCalledWith(SOURCE, '"one"', expect.any(AbortSignal));
    expect(r.state().etag).toBe('"one"');
    r.download.mockResolvedValueOnce(answer("remote", '"two"'));
    expect(await restarted.sync()).toContain("200");
    expect(r.state().etag).toBe('"two"');
    expect(r.apply).toHaveBeenCalledTimes(2); expect(r.reload).not.toHaveBeenCalled();
  });

  it("rejects malformed/version/secret-bearing documents without replacing a good configuration or ETag", async () => {
    const r = rig(); await r.enable();
    for (const body of ["{bad", JSON.stringify({ ...document(), schemaVersion: 2 }), JSON.stringify({ ...document(), settings: {} }),
      JSON.stringify({ ...document(), agent: { ...agent(), providers: { evil: { models: [], apiKey: "secret" } } } })]) {
      r.download.mockResolvedValueOnce({ status: 200, etag: '"bad"', body });
      await expect(r.sync.sync()).rejects.toThrow();
      expect(r.local()).toEqual(agent("remote"));
      expect(r.state().etag).toBe('"one"');
      expect(r.sync.status().error).toBeTruthy();
    }
  });

  it("does not enable or change configuration after a first download failure", async () => {
    const r = rig();
    r.download.mockRejectedValueOnce(new Error("offline"));
    await expect(r.enable()).rejects.toThrow("offline");
    expect(r.sync.status()).toMatchObject({ enabled: false, sourceUrl: "", error: "offline" });
    expect(r.local()).toEqual(agent());
    expect(r.state().etag).toBeNull();
    await expect(r.sync.subscribe("http://localhost/")).rejects.toThrow("HTTPS");
    expect(r.sync.status().error).toContain("HTTPS");
  });

  it("preserves the old ETag after apply failure and exposes the failure", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce(answer("new", '"new"'));
    r.apply.mockRejectedValueOnce(new Error("disk full"));
    await expect(r.sync.sync()).rejects.toThrow("disk full");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.state().etag).toBe('"one"');
    expect(r.sync.status().error).toBe("disk full");
  });

  it("saves reload debt and retries it on 304 without rewriting configuration", async () => {
    const r = rig();
    r.reload.mockRejectedValueOnce(new Error("adapter failed"));
    await expect(r.enable()).rejects.toThrow("reload failed");
    expect(r.sync.status()).toMatchObject({ enabled: true, needsReload: true });
    expect(r.state().etag).toBe('"one"');
    r.apply.mockClear();
    r.download.mockResolvedValueOnce({ status: 304, etag: null, body: "" });
    await r.sync.sync();
    expect(r.sync.status()).toMatchObject({ needsReload: false, error: null });
    expect(r.apply).toHaveBeenCalledTimes(1);
  });

  it("clears conditional requests after local drift and rejects unsolicited 304", async () => {
    const r = rig(); await r.enable(); r.edit("outside edit");
    r.download.mockResolvedValueOnce({ status: 304, etag: null, body: "" });
    await expect(r.sync.sync()).rejects.toThrow("matching local configuration");
    expect(r.download).toHaveBeenLastCalledWith(SOURCE, null, expect.any(AbortSignal));
    await r.sync.sync(); expect(r.local()).toEqual(agent("remote"));
  });

  it.each([200, 304] as const)("reconciles edits made during a %s download before reporting success", async (status) => {
    const r = rig(); await r.enable();
    r.download.mockImplementationOnce(async () => {
      r.edit("edited during download");
      r.settings.setModelMenu([]);
      return status === 304 ? { status, etag: null, body: "" } : answer();
    });
    await r.sync.sync();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(r.reload).toHaveBeenCalledTimes(2);
    expect(r.sync.status().error).toBeNull();
  });

  it("pauses without changing files and resumes with the saved ETag", async () => {
    const r = rig(); await r.enable();
    await r.sync.pause();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.sync.status()).toMatchObject({ enabled: false, sourceUrl: SOURCE });
    expect(await r.sync.sync()).toContain("paused");
    r.download.mockResolvedValueOnce({ status: 304, etag: null, body: "" });
    await r.enable();
    expect(r.download).toHaveBeenLastCalledWith(SOURCE, '"one"', expect.any(AbortSignal));
    expect(r.sync.status().enabled).toBe(true);
    await r.sync.pause();
    await r.sync.subscribe("https://other.example/config-sync/new");
    expect(r.download).toHaveBeenLastCalledWith("https://other.example/config-sync/new", null, expect.any(AbortSignal));
  });

  it("serializes manual/hourly checks and pause behind an active download", async () => {
    const r = rig(); await r.enable();
    let finish!: (value: ConfigDownload) => void;
    r.download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = r.sync.sync();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const pause = r.sync.pause();
    const second = r.sync.sync();
    finish(answer("next", '"next"'));
    await first; await pause;
    expect(await second).toContain("paused");
    expect(r.local()).toEqual(agent("next"));
    expect(r.sync.status().enabled).toBe(false);
  });

  it.each(["publish", "revoke", "pause"] as const)("keeps %s state unchanged when persistence fails", async (operation) => {
    const r = rig();
    if (operation === "pause") await r.enable();
    else await r.sync.publish();
    const before = r.sync.status();
    const persisted = r.state();
    r.db.exec("CREATE TEMP TRIGGER fail_sync_state BEFORE UPDATE ON settings WHEN NEW.key = 'configSync' BEGIN SELECT RAISE(FAIL, 'state write failed'); END");
    await expect(r.sync[operation]()).rejects.toThrow("state write failed");
    expect(r.sync.status()).toEqual(before);
    expect(r.state()).toEqual(persisted);
  });

  it("retains reload debt when saving the completed reload fails", async () => {
    const r = rig();
    r.db.exec(`CREATE TEMP TRIGGER fail_reload_state BEFORE UPDATE ON settings
      WHEN NEW.key = 'configSync' AND json_extract(NEW.value, '$.enabled') = 1
        AND json_extract(NEW.value, '$.needsReload') = 0 AND json_extract(NEW.value, '$.error') IS NULL
      BEGIN SELECT RAISE(FAIL, 'reload state write failed'); END`);
    await expect(r.enable()).rejects.toThrow("reload state write failed");
    expect(r.sync.status()).toMatchObject({ enabled: true, needsReload: true, error: "reload state write failed" });
    expect(new ConfigSync(r.deps).status()).toEqual(r.sync.status());
    r.db.exec("DROP TRIGGER fail_reload_state");
    await r.sync.sync();
    expect(r.reload).toHaveBeenCalledTimes(2);
    expect(r.sync.status().needsReload).toBe(false);
  });

  it("rolls back an import cancelled while waiting to apply", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce(answer("cancelled", '"cancelled"'));
    const apply = r.apply.getMockImplementation()!;
    let release!: () => void;
    r.apply.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await apply(...args);
    });
    const controller = new AbortController();
    const pending = r.sync.sync(controller.signal);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort(); release();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(r.local()).toEqual(agent("remote"));
    expect(r.state().etag).toBe('"one"');
    expect(r.reload).toHaveBeenCalledTimes(1);
  });

  it("rolls back files and menu when the final state write fails", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce({ ...answer(), body: JSON.stringify({ ...document("new"), modelMenu: [] }) });
    r.db.exec(`CREATE TEMP TRIGGER fail_sync_state BEFORE UPDATE ON settings
      WHEN NEW.key = 'configSync' AND json_extract(NEW.value, '$.error') IS NULL
      BEGIN SELECT RAISE(FAIL, 'state write failed'); END`);
    await expect(r.sync.sync()).rejects.toThrow("state write failed");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(new ConfigSync(r.deps).status()).toEqual(r.sync.status());
  });

  it("rolls back files, menu and ETag together when the database commit fails", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce({ ...answer("new", '"new"'), body: JSON.stringify({ ...document("new"), modelMenu: [] }) });
    vi.spyOn(r.settings, "setModelMenu").mockImplementationOnce(() => { throw new Error("DB write failed"); });
    await expect(r.sync.sync()).rejects.toThrow("DB write failed");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(r.state().etag).toBe('"one"');
    expect(r.sync.status().error).toBe("DB write failed");
  });
});

describe("two isolated configuration stores over HTTP", () => {
  it("transfers definitions, revalidates after reopen, and retains local secrets on source revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-sync-http-"));
    const sourceDir = join(root, "source"); const clientDir = join(root, "client");
    mkdirSync(sourceDir); mkdirSync(clientDir);
    const sourceDb = openDb(join(sourceDir, "pier.db"));
    let clientDb = openDb(join(clientDir, "pier.db"));
    const sourceSettings = new SettingsStore(sourceDb);
    sourceSettings.setModelMenu([{ provider: "proxy", id: "m", thinking: "high" }]);
    const sourceConfig = new PiConfigStore(sourceDir);
    const writeModels = (dir: string, key: string, name: string): void => writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { proxy: { baseUrl: `https://${key}.example`, apiKey: key, api: "openai-completions", headers: { authorization: key },
        models: [{ id: "m", name, reasoning: true, headers: { "x-local-key": key } }] } },
    }));
    writeModels(sourceDir, "source-secret", "Remote model"); writeModels(clientDir, "client-secret", "Local model");
    writeFileSync(join(sourceDir, "SYSTEM.md"), "Source rules");
    writeFileSync(join(sourceDir, "settings.json"), '{"localOnly":"source-settings","defaultProvider":"proxy","defaultModel":"m"}');
    writeFileSync(join(clientDir, "settings.json"), '{"localOnly":"client-settings"}');
    const source = new ConfigSync({ db: sourceDb, settings: sourceSettings, config: sourceConfig,
      normalizeAgent: normalizeAgentSnapshot, reload: async () => {},
    });
    const app = new Hono(); registerConfigShareRoute(app, source);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const published = await source.publish();
      const url = `https://source.example${published.publishedPath}`;
      const statuses: number[] = [];
      // Only transport is redirected to loopback; the production URL, redirect
      // and JSON checks remain tested in config-sync-fetch.test.ts.
      const download = async (raw: string, etag: string | null, signal: AbortSignal): Promise<ConfigDownload> => {
        const res = await fetch(`http://127.0.0.1:${port}${new URL(raw).pathname}`, {
          signal, headers: etag ? { "if-none-match": etag } : {},
        });
        statuses.push(res.status);
        if (res.status !== 200 && res.status !== 304) throw new Error(`Source returned HTTP ${res.status}`);
        return { status: res.status, etag: res.headers.get("etag"), body: await res.text() };
      };
      const reload = vi.fn(async () => {});
      const openClient = () => new ConfigSync({ db: clientDb, settings: new SettingsStore(clientDb), config: new PiConfigStore(clientDir),
        normalizeAgent: normalizeAgentSnapshot, download, reload,
      });
      let client = openClient();
      await client.subscribe(url);
      const models = JSON.parse(readFileSync(join(clientDir, "models.json"), "utf8"));
      expect(models.providers.proxy).toMatchObject({ apiKey: "client-secret", baseUrl: "https://client-secret.example", headers: { authorization: "client-secret" },
        models: [{ id: "m", name: "Remote model", headers: { "x-local-key": "client-secret" } }],
      });
      expect(new SettingsStore(clientDb).get().modelMenu).toEqual(sourceSettings.get().modelMenu);
      // The default model travels; every other settings.json field is local.
      expect(JSON.parse(readFileSync(join(clientDir, "settings.json"), "utf8"))).toEqual({
        localOnly: "client-settings", defaultProvider: "proxy", defaultModel: "m",
      });
      expect(readFileSync(join(clientDir, "SYSTEM.md"), "utf8")).toBe("Source rules");
      await client.sync();
      clientDb.close(); clientDb = openDb(join(clientDir, "pier.db")); client = openClient();
      await client.sync();
      expect(statuses).toEqual([200, 304, 304]);
      expect(reload).toHaveBeenCalledTimes(1);
      await sourceConfig.writeFile({ kind: "global" }, "SYSTEM.md", "Updated rules");
      await client.sync(); expect(reload).toHaveBeenCalledTimes(2);
      await source.revoke(); await expect(client.sync()).rejects.toThrow("404");
      expect(client.status().error).toContain("404");
      expect(readFileSync(join(clientDir, "SYSTEM.md"), "utf8")).toBe("Updated rules");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sourceDb.close(); clientDb.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("configuration publication", () => {
  it("publishes a stable content ETag and rotation/revocation invalidates the old capability", async () => {
    const r = rig();
    const first = await r.sync.publish();
    const token = first.publishedPath!.split("/").at(-1)!;
    const published = await r.sync.published(token);
    expect(published?.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await r.sync.published(token)).toEqual(published);
    expect(await r.sync.published("wrong")).toBeNull();
    r.edit("new source");
    expect((await r.sync.published(token))?.etag).not.toBe(published?.etag);
    const second = await r.sync.publish();
    expect(await r.sync.published(token)).toBeNull();
    await r.sync.revoke();
    expect(await r.sync.published(second.publishedPath!.split("/").at(-1)!)).toBeNull();
  });

  it("does not complete a public read after its token was revoked", async () => {
    const r = rig();
    const { publishedPath } = await r.sync.publish();
    let release!: (value: AgentConfigSnapshot) => void;
    vi.spyOn(r.config, "exportSnapshot").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = r.sync.published(publishedPath!.split("/").at(-1)!);
    await r.sync.revoke();
    release(agent());
    expect(await pending).toBeNull();
  });

  it("makes publishing and subscribing mutually exclusive, including resume after pause", async () => {
    const r = rig();
    await r.sync.publish();
    await expect(r.enable()).rejects.toThrow("Revoke the sharing link");
    expect(r.download).not.toHaveBeenCalled();
    await r.sync.revoke(); await r.enable();
    await expect(r.sync.publish()).rejects.toThrow("Pause the configuration subscription");
    expect(r.sync.status().publishedPath).toBeNull();
    await r.sync.pause(); await r.sync.publish();
    await expect(r.enable()).rejects.toThrow("Revoke the sharing link");
    expect(r.sync.status().enabled).toBe(false);
    await r.sync.revoke(); await r.enable();
    expect(r.sync.status().enabled).toBe(true);
  });

  it("serializes concurrent publication and subscription before checking exclusivity", async () => {
    const r = rig();
    const publishing = r.sync.publish();
    await expect(r.enable()).rejects.toThrow("Revoke the sharing link");
    await publishing;
    expect(r.sync.status()).toMatchObject({ enabled: false, publishedPath: expect.any(String) });
    expect(r.download).not.toHaveBeenCalled();
  });

  it("rejects a reflected snapshot from its own instance", async () => {
    const r = rig();
    const published = await r.sync.publish();
    const shared = (await r.sync.published(published.publishedPath!.split("/").at(-1)!))!;
    await r.sync.revoke();
    r.download.mockResolvedValueOnce({ status: 200, etag: shared.etag, body: shared.body });
    await expect(r.enable()).rejects.toThrow("itself");
    expect(r.sync.status().enabled).toBe(false);
  });

  it("canonicalizes objects but preserves array ordering", () => {
    expect(configJson({ z: 1, a: { c: 2, b: 3 } })).toBe(configJson({ a: { b: 3, c: 2 }, z: 1 }));
    expect(configJson([1, 2])).not.toBe(configJson([2, 1]));
  });
});
