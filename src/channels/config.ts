// Channel config persistence and the permission gate every adapter shares.
// One JSON document per platform holds credentials, defaults, bound users and
// the discovered chats — token, groups and permissions in one place, so a
// surface configuring a platform reads and writes exactly one row.
// The shapes live in types.ts; this file is the store and the policy.

import type { DatabaseSync } from "node:sqlite";
import { defaultChannelDbPath, openChannelDb } from "./db.js";
import {
  type BindCode,
  type ChannelConfig,
  type ChannelPlatform,
  type ChatConfig,
  type ChatKind,
  type ChatPolicy,
  defaultChannelConfig,
} from "./types.js";

const BIND_CODE_TTL_MS = 10 * 60_000;

/**
 * Fill in whatever a stored row predates. Chats used to hold `undefined` for
 * "inherit the platform value"; that inheritance is gone, so the platform
 * value is materialised into the chat once, here, on first read.
 */
function normalize(config: ChannelConfig): ChannelConfig {
  config.chats = config.chats.map((chat) => ({
    ...chat,
    requireMention: chat.requireMention ?? config.requireMention,
    requireBind: chat.requireBind ?? config.requireBind,
    topicMode: chat.topicMode ?? config.topicMode,
    cwd: chat.cwd ?? config.cwd,
    model: chat.model ?? config.model,
    thinking: chat.thinking ?? config.thinking,
  }));
  return config;
}

export class ChannelStore {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<ChannelPlatform, ChannelConfig>();

  constructor(path = defaultChannelDbPath()) {
    this.db = openChannelDb(path, `
      CREATE TABLE IF NOT EXISTS channels (
        platform TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      -- Retired tables, dropped here because this store is always constructed:
      -- the Slack message cache (message text at rest is the whole reason it
      -- went away) and the pre-TEXT receipt ledger superseded by
      -- channel_msg_receipts. Delete these lines a release from now.
      DROP TABLE IF EXISTS slack_messages;
      DROP TABLE IF EXISTS slack_sync;
      DROP TABLE IF EXISTS channel_receipts;
    `);
  }

  /**
   * The live cached document. Private on purpose: handing it out let a caller
   * mutate config without saving, so memory and disk could disagree with no
   * way to tell which was right. Internal readers use this; everyone outside
   * gets a copy from get().
   */
  private cached(platform: ChannelPlatform): ChannelConfig {
    const hit = this.cache.get(platform);
    if (hit) return hit;
    const row = this.db.prepare("SELECT json FROM channels WHERE platform = ?").get(platform) as
      | { json: string }
      | undefined;
    const config = normalize(
      row
        ? { ...defaultChannelConfig(), ...(JSON.parse(row.json) as Partial<ChannelConfig>) }
        : defaultChannelConfig(),
    );
    this.cache.set(platform, config);
    return config;
  }

  /** A detached copy: edit it freely, then hand it back to save(). */
  get(platform: ChannelPlatform): ChannelConfig {
    return structuredClone(this.cached(platform));
  }

  save(platform: ChannelPlatform, config: ChannelConfig): void {
    // Clone on the way in too, so the caller keeping its object and mutating
    // it later cannot reach into the cache behind save()'s back.
    this.cache.set(platform, structuredClone(config));
    this.db.prepare(`
      INSERT INTO channels(platform, json) VALUES (?, ?)
      ON CONFLICT(platform) DO UPDATE SET json = excluded.json
    `).run(platform, JSON.stringify(config));
  }

  chat(platform: ChannelPlatform, chatId: string): ChatConfig | undefined {
    return this.get(platform).chats.find((c) => c.id === chatId);
  }

  /**
   * Record a chat the bot just met. Telegram has no "list my chats" API, so
   * discovery is passive. A new chat copies the platform defaults and owns
   * them from then on — the mention and bind gates are what keep it harmless
   * until an operator configures it.
   */
  discoverChat(platform: ChannelPlatform, chat: { id: string; name: string; kind: ChatKind }): void {
    const config = this.get(platform);
    const known = config.chats.find((c) => c.id === chat.id);
    if (known) {
      if (known.name === chat.name && known.kind === chat.kind) return;
      known.name = chat.name || known.name;
      known.kind = chat.kind;
    } else {
      config.chats.push({
        id: chat.id,
        name: chat.name,
        kind: chat.kind,
        enabled: true,
        requireMention: config.requireMention,
        requireBind: config.requireBind,
        topicMode: config.topicMode,
        cwd: config.cwd,
        model: config.model,
        thinking: config.thinking,
      });
    }
    this.save(platform, config);
  }

  // Read-only and on the per-message path: no clone, nothing here escapes.
  // An undiscovered chat falls back to the platform seed; in practice the
  // adapter discovers before it asks.
  policy(platform: ChannelPlatform, chatId: string): ChatPolicy {
    const config = this.cached(platform);
    const chat = config.chats.find((c) => c.id === chatId);
    if (chat) return chat;
    return {
      enabled: true,
      requireMention: config.requireMention,
      requireBind: config.requireBind,
      topicMode: config.topicMode,
      cwd: config.cwd,
      model: config.model,
      thinking: config.thinking,
    };
  }

  isBound(platform: ChannelPlatform, userId: string): boolean {
    return this.cached(platform).users.some((u) => u.id === userId);
  }

  /** Single-use, short-lived code an operator reads off the Console. */
  issueBindCode(platform: ChannelPlatform): BindCode {
    const config = this.get(platform);
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    config.bindCode = { code, expiresAt: Date.now() + BIND_CODE_TTL_MS };
    this.save(platform, config);
    return config.bindCode;
  }

  redeemBindCode(platform: ChannelPlatform, code: string, user: { id: string; name: string }): boolean {
    const config = this.get(platform);
    const pending = config.bindCode;
    if (!pending || pending.expiresAt < Date.now()) return false;
    if (pending.code !== code.trim().toUpperCase()) return false;
    config.bindCode = null;
    if (!config.users.some((u) => u.id === user.id)) {
      config.users.push({ id: user.id, name: user.name, boundAt: Date.now() });
    }
    this.save(platform, config);
    return true;
  }

  unbind(platform: ChannelPlatform, userId: string): void {
    const config = this.get(platform);
    config.users = config.users.filter((u) => u.id !== userId);
    this.save(platform, config);
  }

  close(): void {
    this.db.close();
  }
}

export interface GateInput {
  policy: ChatPolicy;
  isDm: boolean;
  /** Mentioned, replied to, or addressed by a targeted slash command. */
  addressed: boolean;
  bound: boolean;
  /** Bind requests must survive the bind gate, or nobody can ever bind. */
  bindRequest: boolean;
}

export type GateVerdict = "allow" | "chat-disabled" | "not-addressed" | "not-bound";

/**
 * The whole inbound permission policy, platform-blind and total.
 *
 * A group denial is silent by contract: a group where the bot answers "you are
 * not allowed" to every passing message is worse than one that stays quiet.
 * A DM is the exception — two parties, so silence is just confusing — and the
 * adapter answers `not-bound` there.
 */
export function gate({ policy, isDm, addressed, bound, bindRequest }: GateInput): GateVerdict {
  if (!policy.enabled) return "chat-disabled";
  // A DM has exactly two parties: mention is meaningless, and bind is not
  // optional there — it is the only thing between a stranger and an agent with
  // a shell. `requireMention`/`requireBind` are group settings by construction.
  if (isDm) return bound || bindRequest ? "allow" : "not-bound";
  if (policy.requireMention && !addressed) return "not-addressed";
  if (policy.requireBind && !bound && !bindRequest) return "not-bound";
  return "allow";
}
