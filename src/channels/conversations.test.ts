import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationKey } from "../core/types.js";
import { openDb } from "../db.js";
import { ConversationStore, resolveConversation } from "./conversations.js";

const CHAT: ConversationKey = { channelId: "lark", conversationId: "oc_1/om_7" };

let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "pier-conv-")), "pier.db");
  db = openDb(dbPath);
});

afterEach(() => db.close());

/** A restart: the store's connection is gone, the file is not. */
function reopen(): DatabaseSync {
  db.close();
  db = openDb(dbPath);
  return db;
}

/** Fake factory: records what it was asked to open. */
function fakeFactory(existing: string[] = []) {
  const created: { cwd: string; model?: { provider: string; id: string }; thinking?: string }[] = [];
  const resumed: string[] = [];
  let next = 0;
  return {
    created,
    resumed,
    resume(sessionId: string): Promise<{ id: string }> {
      resumed.push(sessionId);
      if (!existing.includes(sessionId)) return Promise.reject(new Error("unknown session"));
      return Promise.resolve({ id: sessionId });
    },
    create(opts: { cwd: string; model?: { provider: string; id: string }; thinking?: string }): Promise<{ id: string }> {
      created.push(opts);
      return Promise.resolve({ id: `s${++next}` });
    },
  };
}

describe("conversation store", () => {
  it("round-trips a mapping and keeps channels apart", () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "s1");
    store.set({ channelId: "slack", conversationId: "C100/1717.7" }, "s2");
    expect(store.get(CHAT)).toBe("s1");
    expect(store.get({ channelId: "slack", conversationId: "C100/1717.7" })).toBe("s2");
    expect(store.get({ channelId: "lark", conversationId: "oc_1/om_8" })).toBeUndefined();
  });

  it("survives a restart — the point of the table", () => {
    const first = new ConversationStore(db);
    first.set(CHAT, "s1");
    const second = new ConversationStore(reopen());
    expect(second.get(CHAT)).toBe("s1");
  });

  it("names the channel that owns a session, and nobody for the rest", () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "s1");
    expect(store.channelOf("s1")).toBe(CHAT.channelId);
    expect(store.channelOf("s2")).toBeUndefined(); // a workbench session
  });

  it("keeps the launch a session was created with, and none for one launched from the defaults", () => {
    const store = new ConversationStore(db);
    const launch = { cwd: "/srv/pier", model: { provider: "anthropic", id: "sonnet" }, thinking: "medium" as const };
    store.set(CHAT, "s1", launch);
    expect(store.launchOf(CHAT)).toEqual(launch);
    store.set(CHAT, "s2");
    expect(store.launchOf(CHAT)).toBeUndefined();
    expect(store.launchOf({ channelId: "lark", conversationId: "none" })).toBeUndefined();
  });

  it("amendLaunch merges model then thinking, and is a no-op without a record", () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "s1", { cwd: "/srv/pier" });
    store.amendLaunch(CHAT, { model: { provider: "anthropic", id: "opus" } });
    store.amendLaunch(CHAT, { thinking: "high" });
    expect(store.launchOf(CHAT)).toEqual({ cwd: "/srv/pier", model: { provider: "anthropic", id: "opus" }, thinking: "high" });
    const other: ConversationKey = { channelId: "slack", conversationId: "C1/1.0" };
    store.set(other, "s2");
    store.amendLaunch(other, { thinking: "high" });
    expect(store.launchOf(other)).toBeUndefined();
  });

  it("re-pointing a conversation replaces the mapping", () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "s1");
    store.set(CHAT, "s2");
    expect(store.get(CHAT)).toBe("s2");
    store.forget(CHAT);
    expect(store.get(CHAT)).toBeUndefined();
  });
});

describe("IM session resolution", () => {
  it("creates once, in the chat's cwd, then resumes forever after", async () => {
    const store = new ConversationStore(db);
    const factory = fakeFactory(["s1"]);
    const resolve = resolveConversation(store, factory, () => ({ cwd: "/srv/ops" }));
    expect((await resolve(CHAT)).id).toBe("s1");
    expect(factory.created).toEqual([{ cwd: "/srv/ops" }]);
    expect((await resolve(CHAT)).id).toBe("s1");
    expect(factory.created).toHaveLength(1);
    expect(factory.resumed).toEqual(["s1"]);
  });

  it("launches a new session with the chat's cwd, model and reasoning", async () => {
    const store = new ConversationStore(db);
    const factory = fakeFactory();
    const model = { provider: "anthropic", id: "claude-opus-4-5" };
    await resolveConversation(store, factory, () => ({ cwd: "/srv/ops", model, thinking: "high" }))(CHAT);
    expect(factory.created).toEqual([{ cwd: "/srv/ops", model, thinking: "high" }]);
  });

  it("falls back to the process cwd when the chat configures none", async () => {
    const store = new ConversationStore(db);
    const factory = fakeFactory();
    await resolveConversation(store, factory, () => ({}))(CHAT);
    expect(factory.created).toEqual([{ cwd: process.cwd() }]);
  });

  it("resumes across a restart instead of re-routing the chat", async () => {
    const before = new ConversationStore(db);
    const first = fakeFactory(["s1"]);
    await resolveConversation(before, first, () => ({}))(CHAT);

    const after = new ConversationStore(reopen());
    const second = fakeFactory(["s1"]);
    expect((await resolveConversation(after, second, () => ({}))(CHAT)).id).toBe("s1");
    expect(second.created).toEqual([]);
  });

  it("stale re-route uses the launch record, not the chat defaults", async () => {
    const store = new ConversationStore(db);
    const launch = { cwd: "/srv/pier", model: { provider: "anthropic", id: "opus" }, thinking: "high" as const };
    store.set(CHAT, "never-written", launch);
    const factory = fakeFactory([]);
    const stale: string[] = [];
    const session = await resolveConversation(store, factory, () => ({ cwd: "/srv/ops" }), (_k, m) => stale.push(m))(CHAT);
    expect(factory.created).toEqual([launch]);
    expect(store.get(CHAT)).toBe(session.id);
    // The record survives the re-create: the next loss re-creates the same way.
    expect(store.launchOf(CHAT)).toEqual(launch);
    expect(stale[0]).toContain(`re-created as ${session.id.slice(0, 8)} with its own settings in /srv/pier`);
  });

  it("falls back to a fresh session when Pi lost the transcript", async () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "gone");
    const factory = fakeFactory([]); // resume always rejects
    const stale: [ConversationKey, string][] = [];
    const resolve = resolveConversation(store, factory, () => ({ cwd: "/srv/ops" }), (k, m) => stale.push([k, m]));
    expect((await resolve(CHAT)).id).toBe("s1");
    // The thread hears it, and the note names the lost session and where it goes on.
    expect(stale).toHaveLength(1);
    expect(stale[0]![0]).toEqual(CHAT);
    expect(stale[0]![1]).toContain("Session gone is gone from disk");
    expect(stale[0]![1]).toContain("new session with the chat defaults in /srv/ops");
    // The dead mapping is replaced, not retried on every later message.
    expect(store.get(CHAT)).toBe("s1");
    expect(factory.resumed).toEqual(["gone"]);
  });
});
