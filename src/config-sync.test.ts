import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiConfigStore } from "./agent/config.js";
import { registerConfigShareRoute } from "./web/config-sync.js";
import { normalizeAgentSnapshot } from "./agent/config-sync.js";
import type { AgentConfigSnapshot, AgentConfigSync } from "./agent/types.js";
import { ConfigSync, configJson, configSourceUrl, CONFIG_SCHEMA_VERSION, CONFIG_SYNC_BYTES, downloadConfig } from "./config-sync.js";
import { openDb } from "./db.js";
import { SettingsStore } from "./settings.js";

const SOURCE = "https://source.example/config-sync/token";
const agent = (text = "local"): AgentConfigSnapshot => ({ files: { "SYSTEM.md": text, "AGENTS.md": null }, providers: {} });
const document = (text = "remote") => ({ schemaVersion: CONFIG_SCHEMA_VERSION, instanceId: "other-instance", agent: agent(text), modelMenu: [{ provider: "anthropic", id: "model", thinking: "medium", tier: "balanced" }] });
const answer = (text = "remote"): string => JSON.stringify(document(text));
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
  const download = vi.fn(async (): Promise<string> => answer());
  const reload = vi.fn(async () => {});
  const deps = { db, settings, config, normalizeAgent: normalizeAgentSnapshot, download, reload };
  const sync = new ConfigSync(deps);
  const enable = () => sync.subscribe(SOURCE);
  const state = (): Record<string, unknown> => JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'configSync'").get() as { value: string }).value) as Record<string, unknown>;
  return { db, settings, config, apply, download, reload, deps, sync, enable, state, local: () => local, edit: (text: string) => { local = agent(text); } };
}

describe("configuration subscription", () => {
  it("downloads on enable, persists state, and keeps unrelated settings", async () => {
    const r = rig();
    r.settings.setPublicUrl("https://local.example");
    r.settings.setTools(["rtk"]);
    expect(r.sync.status().enabled).toBe(false);
    await r.enable();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get()).toMatchObject({ publicUrl: "https://local.example", tools: ["rtk"], modelMenu: document().modelMenu });
    expect(r.reload).toHaveBeenCalledTimes(1);
    expect(new ConfigSync(r.deps).status()).toMatchObject({ enabled: true, sourceUrl: SOURCE });
    expect(Object.keys(r.state()).sort()).toEqual(["enabled", "error", "instanceId", "lastApplied", "lastChecked", "needsReload", "token", "url"]);
  });

  it("drops the keys an older Pier persisted and keeps the rest", async () => {
    const r = rig();
    r.db.prepare("UPDATE settings SET value = ? WHERE key = 'configSync'").run(JSON.stringify({
      instanceId: "kept", token: null, url: SOURCE, enabled: true, etag: '"old"', appliedHash: "abc",
      lastChecked: 5, lastApplied: 4, error: null, needsReload: false,
    }));
    const sync = new ConfigSync(r.deps);
    expect(sync.status()).toMatchObject({ enabled: true, sourceUrl: SOURCE, lastChecked: 5, lastApplied: 4 });
    await sync.pause();
    expect(r.state()).toEqual({ instanceId: "kept", token: null, url: SOURCE, enabled: false, lastChecked: 5, lastApplied: 4, error: null, needsReload: false });
  });

  it("an identical download never writes files or reloads, including after restart", async () => {
    const r = rig(); await r.enable();
    const restarted = new ConfigSync(r.deps);
    r.apply.mockClear(); r.reload.mockClear();
    expect(await restarted.sync()).toContain("unchanged");
    expect(r.download).toHaveBeenLastCalledWith(SOURCE, expect.any(AbortSignal));
    expect(r.apply).toHaveBeenCalledTimes(1); expect(r.reload).not.toHaveBeenCalled();
  });

  it("rejects malformed/secret-bearing documents without replacing a good configuration", async () => {
    const r = rig(); await r.enable();
    for (const body of ["{bad", JSON.stringify({ ...document(), settings: {} }),
      JSON.stringify({ ...document(), modelMenu: [...document().modelMenu, { provider: "a", id: "b", thinking: "low", tier: "fastest" }] }),
      JSON.stringify({ ...document(), agent: { ...agent(), providers: { evil: { models: [], apiKey: "secret" } } } })]) {
      r.download.mockResolvedValueOnce(body);
      await expect(r.sync.sync()).rejects.toThrow();
      expect(r.local()).toEqual(agent("remote"));
      expect(r.sync.status()).toMatchObject({ enabled: true, error: expect.any(String) });
    }
  });

  it("pauses on a source of another schema version, naming both, and applies nothing", async () => {
    const r = rig(); await r.enable();
    r.settings.setModelMenu([]);
    for (const published of [CONFIG_SCHEMA_VERSION - 1, CONFIG_SCHEMA_VERSION + 1, "2", undefined]) {
      r.download.mockResolvedValueOnce(JSON.stringify({ ...document("newer"), schemaVersion: published }));
      await expect(r.sync.subscribe(SOURCE)).rejects.toThrow(`this Pier reads v${String(CONFIG_SCHEMA_VERSION)}`);
      expect(r.sync.status()).toMatchObject({ enabled: false, sourceUrl: SOURCE });
      expect(r.sync.status().error).toMatch(typeof published === "number" ? `schema v${String(published)}` : "unknown version");
      expect(r.local()).toEqual(agent("remote"));
      expect(r.settings.get().modelMenu).toEqual([]);
    }
    // Paused, not broken: the hourly check is a no-op until the operator resumes.
    expect(await r.sync.sync()).toContain("paused");
    await r.enable();
    expect(r.sync.status()).toMatchObject({ enabled: true, error: null });
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
  });

  it("does not enable or change configuration after a first download failure", async () => {
    const r = rig();
    r.download.mockRejectedValueOnce(new Error("offline"));
    await expect(r.enable()).rejects.toThrow("offline");
    expect(r.sync.status()).toMatchObject({ enabled: false, sourceUrl: "", error: "offline" });
    expect(r.local()).toEqual(agent());
    await expect(r.sync.subscribe("http://localhost/")).rejects.toThrow("HTTPS");
    expect(r.sync.status().error).toContain("HTTPS");
  });

  it("keeps the configuration after apply failure and exposes the failure", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce(answer("new"));
    r.apply.mockRejectedValueOnce(new Error("disk full"));
    await expect(r.sync.sync()).rejects.toThrow("disk full");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.sync.status()).toMatchObject({ enabled: true, error: "disk full" });
  });

  it("saves reload debt and retries it on an unchanged download without rewriting configuration", async () => {
    const r = rig();
    r.reload.mockRejectedValueOnce(new Error("adapter failed"));
    await expect(r.enable()).rejects.toThrow("reload failed");
    expect(r.sync.status()).toMatchObject({ enabled: true, needsReload: true });
    r.apply.mockClear();
    await r.sync.sync();
    expect(r.sync.status()).toMatchObject({ needsReload: false, error: null });
    expect(r.apply).toHaveBeenCalledTimes(1);
  });

  it("puts the source back over a local edit, made before or during the download", async () => {
    const r = rig(); await r.enable(); r.edit("outside edit");
    await r.sync.sync(); expect(r.local()).toEqual(agent("remote"));
    r.download.mockImplementationOnce(async () => {
      r.edit("edited during download");
      r.settings.setModelMenu([]);
      return answer();
    });
    await r.sync.sync();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(r.reload).toHaveBeenCalledTimes(3);
    expect(r.sync.status().error).toBeNull();
  });

  it("pauses without changing files and resumes on the saved or a new source", async () => {
    const r = rig(); await r.enable();
    await r.sync.pause();
    expect(r.local()).toEqual(agent("remote"));
    expect(r.sync.status()).toMatchObject({ enabled: false, sourceUrl: SOURCE });
    expect(await r.sync.sync()).toContain("paused");
    await r.enable();
    expect(r.download).toHaveBeenLastCalledWith(SOURCE, expect.any(AbortSignal));
    expect(r.sync.status().enabled).toBe(true);
    await r.sync.pause();
    await r.sync.subscribe("https://other.example/config-sync/new");
    expect(r.download).toHaveBeenLastCalledWith("https://other.example/config-sync/new", expect.any(AbortSignal));
  });

  it("serializes manual/hourly checks and pause behind an active download", async () => {
    const r = rig(); await r.enable();
    let finish!: (value: string) => void;
    r.download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = r.sync.sync();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const pause = r.sync.pause();
    const second = r.sync.sync();
    finish(answer("next"));
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
    r.download.mockResolvedValueOnce(answer("cancelled"));
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
    expect(r.reload).toHaveBeenCalledTimes(1);
  });

  it("rolls back files and menu when the final state write fails", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce(JSON.stringify({ ...document("new"), modelMenu: [] }));
    r.db.exec(`CREATE TEMP TRIGGER fail_sync_state BEFORE UPDATE ON settings
      WHEN NEW.key = 'configSync' AND json_extract(NEW.value, '$.error') IS NULL
      BEGIN SELECT RAISE(FAIL, 'state write failed'); END`);
    await expect(r.sync.sync()).rejects.toThrow("state write failed");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(new ConfigSync(r.deps).status()).toEqual(r.sync.status());
  });

  it("rolls back files and menu together when the database commit fails", async () => {
    const r = rig(); await r.enable();
    r.download.mockResolvedValueOnce(JSON.stringify({ ...document("new"), modelMenu: [] }));
    vi.spyOn(r.settings, "setModelMenu").mockImplementationOnce(() => { throw new Error("DB write failed"); });
    await expect(r.sync.sync()).rejects.toThrow("DB write failed");
    expect(r.local()).toEqual(agent("remote"));
    expect(r.settings.get().modelMenu).toEqual(document().modelMenu);
    expect(r.sync.status().error).toBe("DB write failed");
  });
});

describe("two isolated configuration stores over HTTP", () => {
  it("transfers definitions, stays put after reopen, and retains local secrets on source revocation", async () => {
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
    writeFileSync(join(sourceDir, "settings.json"), '{"localOnly":"source-settings","defaultProvider":"proxy","defaultModel":"m","defaultThinkingLevel":"high"}');
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
      // and JSON checks remain tested in config-sync.test.ts.
      const download = async (raw: string, signal: AbortSignal): Promise<string> => {
        const res = await fetch(`http://127.0.0.1:${port}${new URL(raw).pathname}`, { signal });
        statuses.push(res.status);
        if (res.status !== 200) throw new Error(`Source returned HTTP ${res.status}`);
        return res.text();
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
      // The default model and its reasoning effort travel; every other
      // settings.json field is local.
      expect(JSON.parse(readFileSync(join(clientDir, "settings.json"), "utf8"))).toEqual({
        localOnly: "client-settings", defaultProvider: "proxy", defaultModel: "m", defaultThinkingLevel: "high",
      });
      expect(readFileSync(join(clientDir, "SYSTEM.md"), "utf8")).toBe("Source rules");
      await client.sync();
      clientDb.close(); clientDb = openDb(join(clientDir, "pier.db")); client = openClient();
      await client.sync();
      expect(statuses).toEqual([200, 200, 200]);
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
  it("publishes the current schema version, and rotation/revocation invalidates the old capability", async () => {
    const r = rig();
    const first = await r.sync.publish();
    const token = first.publishedPath!.split("/").at(-1)!;
    const published = await r.sync.published(token);
    expect(JSON.parse(published!)).toMatchObject({ schemaVersion: CONFIG_SCHEMA_VERSION, agent: agent() });
    expect(await r.sync.published(token)).toEqual(published);
    expect(await r.sync.published("wrong")).toBeNull();
    r.edit("new source");
    expect(JSON.parse((await r.sync.published(token))!)).toMatchObject({ agent: agent("new source") });
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
    r.download.mockResolvedValueOnce(shared);
    await expect(r.enable()).rejects.toThrow("itself");
    expect(r.sync.status().enabled).toBe(false);
  });

  it("canonicalizes objects but preserves array ordering", () => {
    expect(configJson({ z: 1, a: { c: 2, b: 3 } })).toBe(configJson({ a: { b: 3, c: 2 }, z: 1 }));
    expect(configJson([1, 2])).not.toBe(configJson([2, 1]));
  });
});

describe("configuration source fetch boundary", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

  function reply(status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }): Response {
    return new Response(body, { status, headers });
  }
  const requested = (): string[] => fetchMock.mock.calls.map((call) => (call[0] as URL).href);

  it("requires HTTPS without embedded credentials/fragments", () => {
    for (const raw of ["file:///etc/passwd", "http://example.com", "https://u:p@example.com", "https://example.com/#token", "bad"]) {
      expect(() => configSourceUrl(raw)).toThrow();
    }
    expect(configSourceUrl(" https://example.com/config-sync/token ").href).toBe("https://example.com/config-sync/token");
  });

  it("sends the request to the source URL", async () => {
    fetchMock.mockResolvedValue(reply(200, "{}"));
    expect(await downloadConfig("https://example.com:8443/config-sync/token", AbortSignal.timeout(1000))).toBe("{}");
    expect(requested()).toEqual(["https://example.com:8443/config-sync/token"]);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "GET", redirect: "manual", headers: { accept: "application/json" },
    }));
  });

  it("reaches private and loopback sources", async () => {
    fetchMock.mockResolvedValue(reply(200, "{}"));
    expect(await downloadConfig("https://pier.internal/config-sync/token", AbortSignal.timeout(1000))).toBe("{}");
  });

  it("follows HTTPS redirects, including relative ones, up to a ceiling", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(302, "", { location: "https://cdn.example.com/token" }))
      .mockResolvedValueOnce(reply(301, "", { location: "/moved/token" }))
      .mockResolvedValueOnce(reply(200, "{}"));
    expect(await downloadConfig("https://example.com/token", AbortSignal.timeout(1000))).toBe("{}");
    expect(requested()).toEqual([
      "https://example.com/token", "https://cdn.example.com/token", "https://cdn.example.com/moved/token",
    ]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(302, "", { location: "https://example.com/loop" }));
    await expect(downloadConfig("https://example.com/token", AbortSignal.timeout(1000))).rejects.toThrow("too many times");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("refuses a redirect that leaves HTTPS", async () => {
    fetchMock.mockResolvedValue(reply(302, "", { location: "http://169.254.169.254/" }));
    await expect(downloadConfig("https://example.com/token", AbortSignal.timeout(1000))).rejects.toThrow("not HTTPS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not accept HTML or read oversized JSON", async () => {
    fetchMock.mockResolvedValue(reply(200, "html", { "content-type": "text/html" }));
    await expect(downloadConfig("https://example.com/token", AbortSignal.timeout(1000))).rejects.toThrow("JSON");
    fetchMock.mockResolvedValue(reply(200, "x".repeat(CONFIG_SYNC_BYTES + 1)));
    await expect(downloadConfig("https://example.com/token", AbortSignal.timeout(1000))).rejects.toThrow("1 MiB");
  });

  it("reports cancellation and refuses revoked links without exposing the token", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = downloadConfig("https://example.com/private-token", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(404, ""));
    await expect(downloadConfig("https://example.com/private-token", AbortSignal.timeout(1000))).rejects.toThrow("revoked");
  });
});
