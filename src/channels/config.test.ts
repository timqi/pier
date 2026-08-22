import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { ChannelStore, gate } from "./config.js";
import type { ChatPolicy } from "./types.js";

let store: ChannelStore;

beforeEach(() => {
  store = new ChannelStore(openDb(":memory:"));
});

describe("sealed tokens", () => {
  let secrets: Secrets;

  beforeEach(async () => {
    secrets = new Secrets(join(mkdtempSync(join(tmpdir(), "pier-ch-")), "master.key"));
    await secrets.unlock();
  });

  it("seals tokens in the row, serves plaintext from get()", () => {
    const db = openDb(":memory:");
    const sealed = new ChannelStore(db, secrets);
    const config = sealed.get("slack");
    config.token = "xoxb-bot";
    config.appToken = "xapp-socket";
    sealed.save("slack", config);
    const row = db.prepare("SELECT json FROM channels WHERE platform = 'slack'").get() as { json: string };
    expect(row.json).not.toContain("xoxb-bot");
    expect(row.json).not.toContain("xapp-socket");
    // The same store and a fresh one (cold cache) both serve plaintext.
    expect(sealed.get("slack").token).toBe("xoxb-bot");
    const fresh = new ChannelStore(db, secrets);
    expect(fresh.get("slack")).toMatchObject({ token: "xoxb-bot", appToken: "xapp-socket" });
  });

  it("honors a legacy plaintext row and re-seals it on the next save", () => {
    const db = openDb(":memory:");
    const plain = new ChannelStore(db); // pre-secrets Pier wrote plaintext
    const config = plain.get("telegram");
    config.token = "12345:legacy";
    plain.save("telegram", config);
    const sealed = new ChannelStore(db, secrets);
    expect(sealed.get("telegram").token).toBe("12345:legacy");
    sealed.save("telegram", sealed.get("telegram"));
    const row = db.prepare("SELECT json FROM channels WHERE platform = 'telegram'").get() as { json: string };
    expect(row.json).not.toContain("12345:legacy");
  });

  it("a locked store refuses rather than serving ciphertext", () => {
    const db = openDb(":memory:");
    const sealed = new ChannelStore(db, secrets);
    const config = sealed.get("slack");
    config.token = "xoxb-bot";
    sealed.save("slack", config);
    const locked = new ChannelStore(db, new Secrets(join(tmpdir(), "nonexistent", "master.key")));
    expect(() => locked.get("slack")).toThrow(/secrets locked/);
  });
});

describe("channel config store", () => {
  it("defaults to least privilege and disabled", () => {
    const config = store.get("telegram");
    expect(config).toMatchObject({
      enabled: false,
      token: "",
      requireMention: true,
      requireBind: true,
      topicMode: true,
      users: [],
      chats: [],
    });
  });

  it("discovers a chat once, seeded from the platform defaults", () => {
    const seeded = store.get("telegram");
    seeded.cwd = "/srv/work";
    seeded.model = { provider: "anthropic", id: "claude-opus-4-5" };
    seeded.thinking = "high";
    store.save("telegram", seeded);
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "forum" });
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "forum" });
    expect(store.get("telegram").chats).toEqual([{
      id: "-100",
      name: "Ops",
      kind: "forum",
      enabled: true,
      requireMention: true,
      requireBind: true,
      topicMode: true,
      cwd: "/srv/work",
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      thinking: "high",
    }]);
    // Seeds, not inheritance: moving the platform default leaves the chat put.
    const moved = store.get("telegram");
    moved.requireMention = false;
    moved.cwd = "/elsewhere";
    store.save("telegram", moved);
    expect(store.policy("telegram", "-100")).toMatchObject({
      requireMention: true,
      cwd: "/srv/work",
    });
  });

  it("renames a known chat without losing its overrides", () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    const config = store.get("telegram");
    config.chats[0]!.requireMention = false;
    store.save("telegram", config);
    store.discoverChat("telegram", { id: "-100", name: "Ops v2", kind: "forum" });
    expect(store.chat("telegram", "-100")).toMatchObject({
      name: "Ops v2",
      kind: "forum",
      requireMention: false,
    });
  });

  it("a chat answers with its own values, an unknown one with the seed", () => {
    const config = store.get("telegram");
    config.requireMention = true;
    config.cwd = "/srv/work";
    const seed = { requireMention: true, requireBind: true, topicMode: true, cwd: "/srv/work", model: null, thinking: null };
    config.chats = [
      { id: "a", name: "a", kind: "group", enabled: true, ...seed, requireMention: false },
      { id: "b", name: "b", kind: "group", enabled: false, ...seed, cwd: "/srv/b" },
    ];
    store.save("telegram", config);
    expect(store.policy("telegram", "a")).toMatchObject({ requireMention: false, cwd: "/srv/work" });
    expect(store.policy("telegram", "b")).toMatchObject({ requireMention: true, enabled: false, cwd: "/srv/b" });
    // Unknown chats fall back to the globals rather than being denied outright;
    // discovery runs first, and the bind gate is what keeps them harmless.
    expect(store.policy("telegram", "zzz")).toMatchObject({ enabled: true, requireMention: true });
  });

  it("redeems a bind code exactly once", () => {
    const { code } = store.issueBindCode("telegram");
    expect(store.redeemBindCode("telegram", code.toLowerCase(), { id: "7", name: "Q" })).toBe(true);
    expect(store.isBound("telegram", "7")).toBe(true);
    expect(store.redeemBindCode("telegram", code, { id: "8", name: "R" })).toBe(false);
    expect(store.isBound("telegram", "8")).toBe(false);
    store.unbind("telegram", "7");
    expect(store.isBound("telegram", "7")).toBe(false);
  });

  it("rejects an expired bind code", () => {
    const { code } = store.issueBindCode("telegram");
    const config = store.get("telegram");
    config.bindCode = { code, expiresAt: Date.now() - 1 };
    store.save("telegram", config);
    expect(store.redeemBindCode("telegram", code, { id: "7", name: "Q" })).toBe(false);
  });

  it("hands out a copy, so an unsaved edit cannot reach the store", () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    const escaped = store.get("telegram");
    escaped.requireBind = false;
    escaped.chats[0]!.enabled = false;
    escaped.users.push({ id: "9", name: "nope", boundAt: 0 });
    expect(store.policy("telegram", "-100")).toMatchObject({ requireBind: true, enabled: true });
    expect(store.isBound("telegram", "9")).toBe(false);
    // And a saved object stays detached afterwards.
    store.save("telegram", escaped);
    escaped.requireMention = false;
    expect(store.policy("telegram", "-100").requireMention).toBe(true);
  });

  it("keeps platforms independent", () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    expect(store.get("slack").chats).toEqual([]);
  });
});

const policy = (over: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true,
  requireMention: true,
  requireBind: true,
  topicMode: true,
  cwd: "",
  model: null,
  thinking: null,
  ...over,
});

describe("inbound gate", () => {
  const base = { isDm: false, addressed: true, bound: true, bindRequest: false };

  it("allows an addressed, bound sender in an enabled chat", () => {
    expect(gate({ policy: policy(), ...base })).toBe("allow");
  });

  it("denies a disabled chat first", () => {
    expect(gate({ policy: policy({ enabled: false }), ...base })).toBe("chat-disabled");
  });

  it("mention gates groups only", () => {
    expect(gate({ policy: policy(), ...base, addressed: false })).toBe("not-addressed");
    expect(gate({ policy: policy(), ...base, addressed: false, isDm: true })).toBe("allow");
    expect(gate({ policy: policy({ requireMention: false }), ...base, addressed: false })).toBe("allow");
  });

  it("bind gates a group as configured, and bind requests survive it", () => {
    expect(gate({ policy: policy(), ...base, bound: false })).toBe("not-bound");
    expect(gate({ policy: policy(), ...base, bound: false, bindRequest: true })).toBe("allow");
    expect(gate({ policy: policy({ requireBind: false }), ...base, bound: false })).toBe("allow");
  });

  it("a DM is bind-only whatever the config says", () => {
    const dm = { ...base, isDm: true, addressed: false };
    // Both group knobs are off, and it still takes a bound sender.
    const open = policy({ requireMention: false, requireBind: false });
    expect(gate({ policy: open, ...dm, bound: false })).toBe("not-bound");
    expect(gate({ policy: open, ...dm, bound: false, bindRequest: true })).toBe("allow");
    expect(gate({ policy: open, ...dm, bound: true })).toBe("allow");
    // Disabling the chat still wins: it is the outermost gate.
    expect(gate({ policy: policy({ enabled: false }), ...dm, bound: true })).toBe("chat-disabled");
  });
});
