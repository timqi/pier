import { Hono } from "hono";
import type { AgentDefaults } from "../agent/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { PIER_WORKSPACE } from "../paths.js";
import { ChannelStore } from "./config.js";
import { registerChannelRoutes } from "./routes.js";
import type { ChannelRuntime } from "./runtime.js";
import type { ChannelView } from "./types.js";

let store: ChannelStore;
let app: Hono;
let reloads: number;
let forgotten: string[];
let agentDefaults: () => Promise<AgentDefaults>;

beforeEach(() => {
  const vault = new Map<string, string>();
  store = new ChannelStore(openDb(":memory:"), { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  reloads = 0;
  app = new Hono();
  const runtime = {
    reload: () => {
      reloads++;
      return Promise.resolve();
    },
  } as unknown as ChannelRuntime;
  forgotten = [];
  agentDefaults = () => Promise.resolve({ defaultModel: { provider: "anthropic", id: "claude-opus-4-5" }, defaultThinkingLevel: "low" });
  registerChannelRoutes(
    app,
    store,
    runtime,
    { forgetChat: (channelId, chatId) => void forgotten.push(`${channelId}:${chatId}`) },
    () => agentDefaults(),
  );
});

const get = async (path = "/api/channels/slack"): Promise<ChannelView> => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as ChannelView;
};

const put = async (body: unknown, path = "/api/channels/slack"): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("channel config routes", () => {
  it("rejects an unknown platform, serves the known ones", async () => {
    expect((await app.request("/api/channels/discord")).status).toBe(404);
    // Every known platform has an adapter now; there is no `supported` flag.
    expect((await app.request("/api/channels/lark")).status).toBe(200);
    expect((await app.request("/api/channels/slack")).status).toBe(200);
  });

  it("names what an empty chat value resolves to, and a save does not store it", async () => {
    const view = await get();
    expect(view.defaults).toEqual({ cwd: PIER_WORKSPACE, model: { provider: "anthropic", id: "claude-opus-4-5" }, thinking: "low" });
    await put({ ...view, cwd: "/srv/x", model: view.defaults.model });
    expect(store.get("slack")).not.toHaveProperty("defaults");
    expect(store.get("slack")).not.toHaveProperty("cwd");
    expect(store.get("slack")).not.toHaveProperty("model");
  });

  it("still serves the page when Settings cannot be read, and says why", async () => {
    agentDefaults = () => Promise.reject(new Error("settings.json is not JSON"));
    expect((await get()).defaults).toEqual({ cwd: PIER_WORKSPACE, model: null, thinking: null, error: "settings.json is not JSON" });
  });

  it("never returns the token, and keeps it when the mask comes back", async () => {
    await put({ enabled: true, token: "xoxb-REAL-SECRET", requireMention: true, requireBind: true });
    const masked = await get();
    expect(masked.token).toBe("••••••••CRET");
    expect(masked.token).not.toContain("REAL");
    // A save that echoes the mask must not overwrite the stored token.
    await put({ ...masked, enabled: false });
    expect(store.get("slack").token).toBe("xoxb-REAL-SECRET");
    expect(reloads).toBe(2);
  });

  it("applies edits without deleting a chat discovered meanwhile", async () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    const stale = await get();
    // The operator's page is now stale: a second chat shows up before they save.
    store.discoverChat("slack", { id: "C200", name: "Later", kind: "group" });
    stale.chats[0]!.requireMention = false;
    stale.chats[0]!.cwd = "/srv/ops";
    await put(stale);
    const chats = store.get("slack").chats;
    expect(chats.map((c) => c.id)).toEqual(["C100", "C200"]);
    expect(chats[0]).toMatchObject({ requireMention: false, cwd: "/srv/ops" });
  });

  it("round-trips a model, and treats a half-filled one as none", async () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    const cfg = await get();
    cfg.chats[0]!.model = { provider: "openai", id: "" } as never;
    cfg.chats[0]!.thinking = "nonsense" as never;
    cfg.chats[0]!.requireMention = false;
    cfg.chats[0]!.cwd = "/srv/ops";
    await put(cfg);
    const saved = store.get("slack");
    // A half-filled model and an unknown reasoning level both read as "none".
    expect(saved.chats[0]).toMatchObject({ model: null, thinking: null, requireMention: false, cwd: "/srv/ops" });
  });

  it("keeps the claimed bot identity, which the page never edits", async () => {
    store.claimBot("slack", "U1");
    await put({ ...(await get()), enabled: true });
    // Reset here, the next start would read as the first and skip the cleanup.
    expect(store.get("slack").botId).toBe("U1");
  });

  it("drops chat ids the store never discovered", async () => {
    await put({ enabled: false, chats: [{ id: "C999", enabled: true }] });
    expect(store.get("slack").chats).toEqual([]);
  });

  it("issues a bind code and unbinds a user, without a channel restart", async () => {
    const res = await app.request("/api/channels/slack/bind-code", { method: "POST" });
    const { code } = (await res.json()) as { code: string };
    expect(store.redeemBindCode("slack", code, { id: "7", name: "Q" })).toBe("bound");
    // A save must not wipe the users it never sees.
    await put({ enabled: true, token: "t" });
    expect(store.isBound("slack", "7")).toBe(true);

    expect((await app.request("/api/channels/slack/users/7", { method: "DELETE" })).status).toBe(200);
    expect(store.isBound("slack", "7")).toBe(false);
    expect(reloads).toBe(1);
  });

  it("deletes a chat with the threads bound to it, and 404s on one it never knew", async () => {
    store.discoverChat("slack", { id: "D1", name: "DM · qiqi", kind: "dm" });
    expect((await app.request("/api/channels/slack/chats/D404", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/channels/lark/chats/D1", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/channels/slack/chats/D1", { method: "DELETE" })).status).toBe(200);
    expect(store.get("slack").chats).toEqual([]);
    expect(forgotten).toEqual(["slack:D1"]);
  });

  it("clears stale chats with their threads, keeping the current bot's", async () => {
    store.claimBot("slack", "U1");
    store.discoverChat("slack", { id: "C1", name: "old", kind: "group" });
    store.claimBot("slack", "U2");
    store.discoverChat("slack", { id: "C2", name: "new", kind: "group" });
    expect((await app.request("/api/channels/nope/clear-stale", { method: "POST" })).status).toBe(404);
    const res = await app.request("/api/channels/slack/clear-stale", { method: "POST" });
    expect(await res.json()).toEqual({ cleared: ["C1"] });
    expect(store.get("slack").chats.map((c) => c.id)).toEqual(["C2"]);
    expect(forgotten).toEqual(["slack:C1"]);
  });

  it("a home DM clears the other platform's and drops its threads only when it changed", async () => {
    store.discoverChat("slack", { id: "D1", name: "qiqi", kind: "dm" });
    store.discoverChat("slack", { id: "C1", name: "ops", kind: "group" });
    store.discoverChat("lark", { id: "oc_1", name: "qiqi", kind: "dm" });
    store.setHome("lark", "oc_1");
    const cfg = await get();
    cfg.chats[0]!.home = true;
    cfg.chats[1]!.home = true; // a group never is
    await put(cfg);
    expect(store.home()).toEqual({ platform: "slack", chatId: "D1" });
    expect(store.get("slack").chats.map((c) => c.home)).toEqual([true, undefined]);
    expect(store.get("lark").chats[0]!.home).toBeUndefined();
    expect(forgotten).toEqual(["slack:D1"]);
    // Saved again unchanged: still the home, nothing forgotten twice.
    await put(await get());
    expect(forgotten).toEqual(["slack:D1"]);
    // Switched off: no home anywhere.
    const off = await get();
    delete off.chats[0]!.home;
    await put(off);
    expect(store.home()).toBeUndefined();
  });

  it("rejects a body that is not an object", async () => {
    expect((await put("nope")).status).toBe(400);
    expect(reloads).toBe(0);
  });
});
