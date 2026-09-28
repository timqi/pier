import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { PIER_WORKSPACE } from "../paths.js";
import { Secrets } from "../secrets.js";
import { Vault } from "../vault.js";
import { ChannelStore, gate } from "./config.js";
import { type ChatPolicy, defaultChannelConfig } from "./types.js";

let db: DatabaseSync;
let secrets: Secrets;
let store: ChannelStore;

beforeEach(async () => {
  db = openDb(":memory:");
  secrets = new Secrets(join(mkdtempSync(join(tmpdir(), "pier-ch-")), "master.key"));
  await secrets.unlock();
  store = new ChannelStore(db, new Vault(secrets, db));
});

describe("credentials in the vault", () => {
  const rowJson = (platform: string): string =>
    (db.prepare("SELECT json FROM channels WHERE platform = ?").get(platform) as { json: string }).json;

  it("files tokens under their fixed names, serves plaintext from get(), and keeps the row free of them", () => {
    const config = store.get("slack");
    config.token = "xoxb-bot";
    config.appToken = "xapp-socket";
    store.save("slack", config);
    expect(JSON.parse(rowJson("slack"))).not.toHaveProperty("token");
    expect(JSON.parse(rowJson("slack"))).not.toHaveProperty("appToken");
    expect(new Vault(secrets, db).list().map((e) => [e.name, e.level])).toEqual([
      ["SLACK_APP_TOKEN", "auto"],
      ["SLACK_TOKEN", "auto"],
    ]);
    // The same store and a fresh one (cold cache) both serve plaintext.
    expect(store.get("slack").token).toBe("xoxb-bot");
    const fresh = new ChannelStore(db, new Vault(secrets, db));
    expect(fresh.get("slack")).toMatchObject({ token: "xoxb-bot", appToken: "xapp-socket" });
  });

  it("an emptied field removes the vault row; a removed row empties the field", () => {
    const vault = new Vault(secrets, db);
    const config = store.get("lark");
    config.token = "cli_app";
    store.save("lark", config);
    expect(vault.get("LARK_APP_ID")).toBe("cli_app");
    config.token = "";
    store.save("lark", config);
    expect(vault.get("LARK_APP_ID")).toBeUndefined();
    // Filed in the Vault topic, read by the channel; removed there, gone here.
    vault.seal("LARK_APP_ID", "cli_other");
    expect(new ChannelStore(db, vault).get("lark").token).toBe("cli_other");
    vault.remove("LARK_APP_ID");
    expect(new ChannelStore(db, vault).get("lark").token).toBe("");
  });

  it("only a changed credential touches the vault, so its updated_at is the rotation", () => {
    const vault = new Vault(secrets, db);
    const config = store.get("slack");
    config.token = "xoxb-bot";
    store.save("slack", config);
    const filed = db.prepare("SELECT value, updated_at FROM vault WHERE name = 'SLACK_TOKEN'").get();
    store.discoverChat("slack", { id: "C1", name: "ops", kind: "group" });
    store.save("slack", store.get("slack"));
    expect(db.prepare("SELECT value, updated_at FROM vault WHERE name = 'SLACK_TOKEN'").get()).toEqual(filed);
    expect(vault.list().map((e) => e.name)).toEqual(["SLACK_TOKEN"]);
  });

  it("a locked store refuses rather than serving ciphertext", () => {
    const config = store.get("slack");
    config.token = "xoxb-bot";
    store.save("slack", config);
    const locked = new ChannelStore(db, new Vault(new Secrets(join(tmpdir(), "nonexistent", "master.key")), db));
    expect(() => locked.get("slack")).toThrow(/secrets locked/);
  });
});

describe("channel config store", () => {
  it("defaults to least privilege and disabled", () => {
    const config = store.get("slack");
    expect(config).toMatchObject({
      enabled: false,
      token: "",
      requireMention: true,
      requireBind: true,
      users: [],
      chats: [],
    });
  });

  it("discovers a chat once, seeding its gates and following the launch defaults", () => {
    const seeded = store.get("slack");
    seeded.requireMention = false;
    store.save("slack", seeded);
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.get("slack").chats).toEqual([{
      id: "C100",
      name: "Ops",
      kind: "group",
      enabled: true,
      requireMention: false,
      requireBind: true,
      cwd: "",
      model: null,
      thinking: null,
      botId: "",
    }]);
    // Gates are seeds: moving the platform's leaves an existing chat alone.
    const moved = store.get("slack");
    moved.requireMention = true;
    store.save("slack", moved);
    expect(store.policy("slack", "C100")).toMatchObject({ requireMention: false });
  });

  it("launches on the chat's own value, else the workspace and Settings", () => {
    const config = store.get("slack");
    const seed = { enabled: true, requireMention: true, requireBind: true, botId: "" };
    config.chats = [
      { id: "own", name: "own", kind: "group", ...seed, cwd: "/srv/own", model: { provider: "a", id: "m" }, thinking: "high" },
      { id: "follow", name: "follow", kind: "group", ...seed, cwd: "", model: null, thinking: null },
    ];
    store.save("slack", config);
    expect(store.launch("slack", "own")).toEqual({ cwd: "/srv/own", model: { provider: "a", id: "m" }, thinking: "high" });
    // null is the Settings default, which Pi applies; the directory is the
    // workspace, never the process cwd nor the main session's home.
    expect(store.launch("slack", "follow")).toEqual({ cwd: PIER_WORKSPACE, model: null, thinking: null });
    expect(store.launch("slack", "unknown")).toEqual({ cwd: PIER_WORKSPACE, model: null, thinking: null });
  });

  it("ignores the launch values a row stored at platform level, and drops them on save", () => {
    db.prepare("INSERT INTO channels(platform, json) VALUES ('slack', ?)").run(JSON.stringify({
      ...defaultChannelConfig(),
      cwd: "/srv/old",
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      thinking: "high",
      chats: [{ id: "C1", name: "c", kind: "group", enabled: true, requireMention: true, requireBind: true, cwd: "", model: null, thinking: null, botId: "" }],
    }));
    expect(store.get("slack")).not.toHaveProperty("cwd");
    expect(store.launch("slack", "C1")).toEqual({ cwd: PIER_WORKSPACE, model: null, thinking: null });
    store.save("slack", store.get("slack"));
    const row = db.prepare("SELECT json FROM channels WHERE platform = 'slack'").get() as { json: string };
    expect(JSON.parse(row.json)).not.toHaveProperty("model");
  });

  it("clears the rows no message restamped under the current bot, the home DM aside", () => {
    // Before any identity nothing is stale.
    store.discoverChat("slack", { id: "C0", name: "Early", kind: "group" });
    store.discoverChat("slack", { id: "D0", name: "Home", kind: "dm" });
    store.setHome("slack", "D0");
    expect(store.clearStale("slack")).toEqual([]);
    // Unstamped rows become stale once an identity is recorded.
    store.claimBot("slack", "U1");
    store.discoverChat("slack", { id: "C1", name: "Old", kind: "group" });
    expect(store.clearStale("slack")).toEqual(["C0"]);
    expect(store.get("slack").chats.map((c) => c.id)).toEqual(["D0", "C1"]);
    // A swap keeps the old bot's groups, stale, until traffic restamps them.
    store.discoverChat("slack", { id: "C2", name: "Busy", kind: "group" });
    store.claimBot("slack", "U2");
    store.discoverChat("slack", { id: "C2", name: "Busy", kind: "group" });
    store.discoverChat("slack", { id: "C3", name: "New", kind: "group" });
    expect(store.get("slack").chats.map((c) => [c.id, c.botId])).toEqual([["C1", "U1"], ["C2", "U2"], ["C3", "U2"]]);
    expect(store.clearStale("slack")).toEqual(["C1"]);
    expect(store.get("slack").chats.map((c) => c.id)).toEqual(["C2", "C3"]);
    expect(store.clearStale("slack")).toEqual([]);
  });

  it("stamps every chat with the bot that saw it, and restamps on the next message", () => {
    store.claimBot("slack", "U1");
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.chat("slack", "C100")?.botId).toBe("U1");
    // A group survives the swap carrying the old stamp; its next message
    // proves it is reachable under the new bot.
    store.claimBot("slack", "U2");
    expect(store.chat("slack", "C100")?.botId).toBe("U1");
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.chat("slack", "C100")?.botId).toBe("U2");
  });

  it("removes a chat by id and says when there was none", () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.removeChat("slack", "C404")).toBe(false);
    expect(store.removeChat("slack", "C100")).toBe(true);
    expect(store.get("slack").chats).toEqual([]);
    // Undone by using it: the next message discovers the chat again.
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.chat("slack", "C100")).toBeDefined();
  });

  it("renames a known chat without losing its overrides", () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    const config = store.get("slack");
    config.chats[0]!.requireMention = false;
    store.save("slack", config);
    store.discoverChat("slack", { id: "C100", name: "Ops v2", kind: "dm" });
    expect(store.chat("slack", "C100")).toMatchObject({
      name: "Ops v2",
      kind: "dm",
      requireMention: false,
    });
  });

  it("a chat answers with its own values, an unknown one with the seed", () => {
    const config = store.get("slack");
    config.requireMention = true;
    const seed = { requireMention: true, requireBind: true, cwd: "/srv/work", model: null, thinking: null, botId: "" };
    config.chats = [
      { id: "a", name: "a", kind: "group", enabled: true, ...seed, requireMention: false },
      { id: "b", name: "b", kind: "group", enabled: false, ...seed, cwd: "/srv/b" },
    ];
    store.save("slack", config);
    expect(store.policy("slack", "a")).toMatchObject({ requireMention: false, cwd: "/srv/work" });
    expect(store.policy("slack", "b")).toMatchObject({ requireMention: true, enabled: false, cwd: "/srv/b" });
    // Unknown chats fall back to the globals rather than being denied outright;
    // discovery runs first, and the bind gate is what keeps them harmless.
    expect(store.policy("slack", "zzz")).toMatchObject({ enabled: true, requireMention: true, cwd: "" });
  });

  it("redeems a bind code exactly once", () => {
    const { code } = store.issueBindCode("slack");
    expect(code).toMatch(/^[0-9A-Z]{6}$/);
    expect(store.redeemBindCode("slack", code.toLowerCase(), { id: "7", name: "Q" }))
      .toBe("bound");
    expect(store.isBound("slack", "7")).toBe(true);
    expect(store.redeemBindCode("slack", code, { id: "8", name: "R" })).toBe("invalid");
    expect(store.isBound("slack", "8")).toBe(false);
    store.unbind("slack", "7");
    expect(store.isBound("slack", "7")).toBe(false);
  });

  it("voids a bind code after five wrong tries, and says so on the fifth", () => {
    const { code } = store.issueBindCode("slack");
    for (let i = 0; i < 4; i++) {
      expect(store.redeemBindCode("slack", "AAAAAA", { id: "7", name: "Q" })).toBe("invalid");
    }
    expect(store.redeemBindCode("slack", "AAAAAA", { id: "7", name: "Q" })).toBe("voided");
    // The real code is dead too, and no longer pending in the Console.
    expect(store.redeemBindCode("slack", code, { id: "7", name: "Q" })).toBe("invalid");
    expect(store.isBound("slack", "7")).toBe(false);
    expect(store.get("slack").bindCode).toBeNull();
    // A fresh code starts over.
    const next = store.issueBindCode("slack").code;
    expect(store.redeemBindCode("slack", next, { id: "7", name: "Q" })).toBe("bound");
  });

  it("rejects an expired bind code", () => {
    const { code } = store.issueBindCode("slack");
    const config = store.get("slack");
    config.bindCode = { code, expiresAt: Date.now() - 1 };
    store.save("slack", config);
    expect(store.redeemBindCode("slack", code, { id: "7", name: "Q" })).toBe("invalid");
  });

  it("hands out a copy, so an unsaved edit cannot reach the store", () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    const escaped = store.get("slack");
    escaped.requireBind = false;
    escaped.chats[0]!.enabled = false;
    escaped.users.push({ id: "9", name: "nope", boundAt: 0 });
    expect(store.policy("slack", "C100")).toMatchObject({ requireBind: true, enabled: true });
    expect(store.isBound("slack", "9")).toBe(false);
    // And a saved object stays detached afterwards.
    store.save("slack", escaped);
    escaped.requireMention = false;
    expect(store.policy("slack", "C100").requireMention).toBe(true);
  });

  it("keeps platforms independent", () => {
    store.discoverChat("slack", { id: "C100", name: "Ops", kind: "group" });
    expect(store.get("lark").chats).toEqual([]);
  });
});

describe("the home chat", () => {
  beforeEach(() => {
    store.discoverChat("slack", { id: "D1", name: "qiqi", kind: "dm" });
    store.discoverChat("slack", { id: "D2", name: "ann", kind: "dm" });
    store.discoverChat("slack", { id: "C1", name: "ops", kind: "group" });
    store.discoverChat("lark", { id: "oc_1", name: "qiqi", kind: "dm" });
  });
  const homes = (): string[] =>
    (["slack", "lark"] as const).flatMap((p) => store.get(p).chats.filter((c) => c.home).map((c) => `${p}:${c.id}`));

  it("is one row across both platforms", () => {
    expect(store.home()).toBeUndefined();
    store.setHome("slack", "D1");
    store.setHome("slack", "D2");
    expect(homes()).toEqual(["slack:D2"]);
    expect(store.home()).toEqual({ platform: "slack", chatId: "D2" });
    store.setHome("slack", null);
    expect(homes()).toEqual([]);
  });

  it("set on lark clears slack's", () => {
    store.setHome("slack", "D1");
    store.setHome("lark", "oc_1");
    expect(homes()).toEqual(["lark:oc_1"]);
    expect(store.home()).toEqual({ platform: "lark", chatId: "oc_1" });
  });

  it("refuses a group or an unknown chat, changing nothing", () => {
    store.setHome("slack", "D1");
    expect(() => store.setHome("slack", "C1")).toThrow(/not a known DM/);
    expect(() => store.setHome("lark", "D1")).toThrow(/not a known DM/);
    expect(homes()).toEqual(["slack:D1"]);
  });
});

const policy = (over: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true,
  requireMention: true,
  requireBind: true,
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
