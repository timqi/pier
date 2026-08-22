import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationKey } from "../core/types.js";
import { openDb } from "../db.js";
import { ConversationStore, resolveConversation } from "./conversations.js";

const CHAT: ConversationKey = { channelId: "telegram", conversationId: "-100/7" };

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
    store.set({ channelId: "slack", conversationId: "-100/7" }, "s2");
    expect(store.get(CHAT)).toBe("s1");
    expect(store.get({ channelId: "slack", conversationId: "-100/7" })).toBe("s2");
    expect(store.get({ channelId: "telegram", conversationId: "-100/8" })).toBeUndefined();
  });

  it("survives a restart — the point of the table", () => {
    const first = new ConversationStore(db);
    first.set(CHAT, "s1");
    const second = new ConversationStore(reopen());
    expect(second.get(CHAT)).toBe("s1");
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

  it("falls back to a fresh session when Pi lost the transcript", async () => {
    const store = new ConversationStore(db);
    store.set(CHAT, "gone");
    const factory = fakeFactory([]); // resume always rejects
    const stale: string[] = [];
    const resolve = resolveConversation(store, factory, () => ({}), (m) => stale.push(m));
    expect((await resolve(CHAT)).id).toBe("s1");
    expect(stale).toHaveLength(1);
    // The dead mapping is replaced, not retried on every later message.
    expect(store.get(CHAT)).toBe("s1");
    expect(factory.resumed).toEqual(["gone"]);
  });
});
