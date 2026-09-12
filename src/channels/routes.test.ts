import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { HandoffError } from "./handoff.js";
import { registerChannelRoutes } from "./routes.js";
import type { ChannelRuntime } from "./runtime.js";
import type { ChannelConfig, HandoffRequest, HandoffTarget } from "./types.js";

let store: ChannelStore;
let app: Hono;
let reloads: number;
let handoffs: HandoffRequest[];
let refuse: HandoffError | undefined;
const TARGETS: HandoffTarget[] = [{ platform: "slack", chatId: "C100", name: "#ops", kind: "group" }];

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
  handoffs = [];
  refuse = undefined;
  registerChannelRoutes(app, store, runtime, {
    targets: () => TARGETS,
    continueIn: (req) => {
      handoffs.push(req);
      return refuse ? Promise.reject(refuse) : Promise.resolve({ conversationId: `${req.chatId}/1.0` });
    },
  });
});

const get = async (path = "/api/channels/slack"): Promise<ChannelConfig & { supported: boolean }> => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as ChannelConfig & { supported: boolean };
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
    cfg.model = { provider: "anthropic", id: "claude-opus-4-5" };
    cfg.thinking = "high";
    cfg.chats[0]!.model = { provider: "openai", id: "" } as never;
    cfg.chats[0]!.thinking = "nonsense" as never;
    cfg.chats[0]!.requireMention = false;
    cfg.chats[0]!.cwd = "/srv/ops";
    await put(cfg);
    const saved = store.get("slack");
    expect(saved).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-4-5" }, thinking: "high" });
    // A half-filled model and an unknown reasoning level both read as "none".
    expect(saved.chats[0]).toMatchObject({ model: null, thinking: null, requireMention: false, cwd: "/srv/ops" });
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

  it("rejects a body that is not an object", async () => {
    expect((await put("nope")).status).toBe(400);
    expect(reloads).toBe(0);
  });
});

describe("handoff routes", () => {
  const post = (body: unknown): Response | Promise<Response> =>
    app.request("/api/handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists the targets", async () => {
    const res = await app.request("/api/handoff/targets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targets: TARGETS });
  });

  it("answers 201 with the conversation the session now answers in", async () => {
    const res = await post({ sessionId: "s1", platform: "slack", chatId: "C100" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ conversationId: "C100/1.0" });
    expect(handoffs).toEqual([{ sessionId: "s1", platform: "slack", chatId: "C100" }]);
  });

  it("rejects an invalid body before asking anyone", async () => {
    expect((await post({ sessionId: "s1", platform: "discord", chatId: "C100" })).status).toBe(400);
    expect((await post({ sessionId: "", platform: "slack", chatId: "C100" })).status).toBe(400);
    expect((await post({ sessionId: "s1", platform: "slack" })).status).toBe(400);
    expect((await app.request("/api/handoff", { method: "POST", body: "not json" })).status).toBe(400);
    expect(handoffs).toEqual([]);
  });

  it("relays a refusal with its status and sentence", async () => {
    for (const status of [404, 409, 502] as const) {
      refuse = new HandoffError(status, `no (${String(status)})`);
      const res = await post({ sessionId: "s1", platform: "lark", chatId: "oc_1" });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `no (${String(status)})` });
    }
  });
});
