import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { registerChannelRoutes } from "./routes.js";
import type { ChannelRuntime } from "./runtime.js";
import type { ChannelConfig } from "./types.js";

let store: ChannelStore;
let app: Hono;
let reloads: number;

beforeEach(() => {
  store = new ChannelStore(openDb(":memory:"));
  reloads = 0;
  app = new Hono();
  const runtime = {
    reload: () => {
      reloads++;
      return Promise.resolve();
    },
  } as unknown as ChannelRuntime;
  registerChannelRoutes(app, store, runtime);
});

const get = async (path = "/api/channels/telegram"): Promise<ChannelConfig & { supported: boolean }> => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as ChannelConfig & { supported: boolean };
};

const put = async (body: unknown, path = "/api/channels/telegram"): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("channel config routes", () => {
  it("rejects an unknown platform, serves the planned ones", async () => {
    expect((await app.request("/api/channels/discord")).status).toBe(404);
    // Lark is configurable but has no adapter; Telegram and Slack have one.
    expect((await get("/api/channels/lark")).supported).toBe(false);
    expect((await get("/api/channels/slack")).supported).toBe(true);
    expect((await get()).supported).toBe(true);
  });

  it("never returns the token, and keeps it when the mask comes back", async () => {
    await put({ enabled: true, token: "123:REAL-SECRET", requireMention: true, requireBind: true, topicMode: true });
    const masked = await get();
    expect(masked.token).toBe("••••••••CRET");
    expect(masked.token).not.toContain("REAL");
    // A save that echoes the mask must not overwrite the stored token.
    await put({ ...masked, enabled: false });
    expect(store.get("telegram").token).toBe("123:REAL-SECRET");
    expect(reloads).toBe(2);
  });

  it("applies edits without deleting a chat discovered meanwhile", async () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "forum" });
    const stale = await get();
    // The operator's page is now stale: a second chat shows up before they save.
    store.discoverChat("telegram", { id: "-200", name: "Later", kind: "group" });
    stale.chats[0]!.requireMention = false;
    stale.chats[0]!.cwd = "/srv/ops";
    await put(stale);
    const chats = store.get("telegram").chats;
    expect(chats.map((c) => c.id)).toEqual(["-100", "-200"]);
    expect(chats[0]).toMatchObject({ requireMention: false, cwd: "/srv/ops" });
  });

  it("round-trips a model, and treats a half-filled one as none", async () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    const cfg = await get();
    cfg.model = { provider: "anthropic", id: "claude-opus-4-5" };
    cfg.thinking = "high";
    cfg.chats[0]!.model = { provider: "openai", id: "" } as never;
    cfg.chats[0]!.thinking = "nonsense" as never;
    cfg.chats[0]!.requireMention = false;
    cfg.chats[0]!.cwd = "/srv/ops";
    await put(cfg);
    const saved = store.get("telegram");
    expect(saved).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-4-5" }, thinking: "high" });
    // A half-filled model and an unknown reasoning level both read as "none".
    expect(saved.chats[0]).toMatchObject({ model: null, thinking: null, requireMention: false, cwd: "/srv/ops" });
  });

  it("drops chat ids the store never discovered", async () => {
    await put({ enabled: false, chats: [{ id: "-999", enabled: true }] });
    expect(store.get("telegram").chats).toEqual([]);
  });

  it("issues a bind code and unbinds a user, without a channel restart", async () => {
    const res = await app.request("/api/channels/telegram/bind-code", { method: "POST" });
    const { code } = (await res.json()) as { code: string };
    expect(store.redeemBindCode("telegram", code, { id: "7", name: "Q" })).toBe(true);
    // A save must not wipe the users it never sees.
    await put({ enabled: true, token: "t" });
    expect(store.isBound("telegram", "7")).toBe(true);

    expect((await app.request("/api/channels/telegram/users/7", { method: "DELETE" })).status).toBe(200);
    expect(store.isBound("telegram", "7")).toBe(false);
    expect(reloads).toBe(1);
  });

  it("rejects a body that is not an object", async () => {
    expect((await put("nope")).status).toBe(400);
    expect(reloads).toBe(0);
  });
});
