// Channel config persistence and the permission gate every adapter shares: one
// JSON document per platform, so a surface configuring one reads and writes one row.

import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Vault } from "../vault.js";
import {
  type BindCode,
  type BindOutcome,
  type ChannelConfig,
  type ChannelPlatform,
  type ChatConfig,
  type ChatKind,
  type ChatPolicy,
  defaultChannelConfig,
} from "./types.js";

const BIND_CODE_TTL_MS = 10 * 60_000;
/** Six symbols out of 36 is 2 billion, but a caller who may retry forever only
 *  needs the TTL; five wrong tries void the code instead. */
const BIND_CODE_TRIES = 5;
const BIND_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

type CredentialKey = "token" | "appToken";

/** Where each platform's credentials live in the vault — fixed names, so a
 *  skill and the Console agree without a setting. Migration 24 spells the same
 *  table in SQL. Telegram authenticates with one token. */
export const CREDENTIAL_NAMES: Record<ChannelPlatform, Partial<Record<CredentialKey, string>>> = {
  telegram: { token: "TELEGRAM_TOKEN" },
  slack: { token: "SLACK_TOKEN", appToken: "SLACK_APP_TOKEN" },
  lark: { token: "LARK_APP_ID", appToken: "LARK_APP_SECRET" },
};

export class ChannelStore {
  private readonly cache = new Map<ChannelPlatform, ChannelConfig>();

  /** The row never holds a credential: `token`/`appToken` are filled from the
   *  vault on read and filed there on save. A locked vault throws rather than
   *  serving a token it cannot read. */
  constructor(private readonly db: DatabaseSync, private readonly vault: Pick<Vault, "get" | "seal" | "remove">) {}

  /** Private: handed out, a caller could mutate config without saving. */
  private cached(platform: ChannelPlatform): ChannelConfig {
    const hit = this.cache.get(platform);
    if (hit) return hit;
    const row = this.db.prepare("SELECT json FROM channels WHERE platform = ?").get(platform) as
      | { json: string }
      | undefined;
    const config = row
      ? { ...defaultChannelConfig(), ...(JSON.parse(row.json) as Partial<ChannelConfig>) }
      : defaultChannelConfig();
    for (const [key, name] of Object.entries(CREDENTIAL_NAMES[platform]) as [CredentialKey, string][]) {
      config[key] = this.vault.get(name) ?? "";
    }
    this.cache.set(platform, config);
    return config;
  }

  get(platform: ChannelPlatform): ChannelConfig {
    return structuredClone(this.cached(platform));
  }

  save(platform: ChannelPlatform, config: ChannelConfig): void {
    // The cache holds plaintext; the row holds neither key. Only a changed
    // credential touches the vault, so its `updated` is the rotation, not the
    // last chat discovered; an emptied field removes the row.
    const before = this.cached(platform);
    for (const [key, name] of Object.entries(CREDENTIAL_NAMES[platform]) as [CredentialKey, string][]) {
      if (config[key] === before[key]) continue;
      if (config[key]) this.vault.seal(name, config[key]);
      else this.vault.remove(name);
    }
    // Cloned, so the caller's object cannot reach into the cache later.
    this.cache.set(platform, structuredClone(config));
    const { token: _token, appToken: _appToken, ...stored } = config;
    this.db.prepare(`
      INSERT INTO channels(platform, json) VALUES (?, ?)
      ON CONFLICT(platform) DO UPDATE SET json = excluded.json
    `).run(platform, JSON.stringify(stored));
  }

  chat(platform: ChannelPlatform, chatId: string): ChatConfig | undefined {
    return this.get(platform).chats.find((c) => c.id === chatId);
  }

  /** Telegram has no "list my chats" API, so discovery is passive and happens
   *  on every message: the unchanged case must cost no clone. A new chat copies
   *  the platform defaults and owns them from then on. */
  discoverChat(platform: ChannelPlatform, chat: { id: string; name: string; kind: ChatKind }): void {
    const cached = this.cached(platform).chats.find((c) => c.id === chat.id);
    if (cached && cached.name === chat.name && cached.kind === chat.kind) return;
    const config = this.get(platform);
    const known = config.chats.find((c) => c.id === chat.id);
    if (known) {
      known.name = chat.name || known.name;
      known.kind = chat.kind;
    } else {
      config.chats.push({
        id: chat.id,
        name: chat.name,
        kind: chat.kind,
        ...this.policy(platform, chat.id),
      });
    }
    this.save(platform, config);
  }

  // On the per-message path: no clone, nothing here escapes.
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

  /** `randomInt` rejection-samples, and this code is the whole distance
   *  between a stranger and an agent with a shell. */
  issueBindCode(platform: ChannelPlatform): BindCode {
    const config = this.get(platform);
    const code = Array.from(
      { length: 6 },
      () => BIND_CODE_ALPHABET[randomInt(BIND_CODE_ALPHABET.length)],
    ).join("");
    config.bindCode = { code, expiresAt: Date.now() + BIND_CODE_TTL_MS };
    this.save(platform, config);
    return config.bindCode;
  }

  redeemBindCode(
    platform: ChannelPlatform,
    code: string,
    user: { id: string; name: string },
  ): BindOutcome {
    const config = this.get(platform);
    const pending = config.bindCode;
    if (!pending || pending.expiresAt < Date.now()) return "invalid";
    if (pending.code !== code.trim().toUpperCase()) {
      const tries = (pending.tries ?? 0) + 1;
      const voided = tries >= BIND_CODE_TRIES;
      config.bindCode = voided ? null : { ...pending, tries };
      this.save(platform, config);
      return voided ? "voided" : "invalid";
    }
    config.bindCode = null;
    if (!config.users.some((u) => u.id === user.id)) {
      config.users.push({ id: user.id, name: user.name, boundAt: Date.now() });
    }
    this.save(platform, config);
    return "bound";
  }

  unbind(platform: ChannelPlatform, userId: string): void {
    const config = this.get(platform);
    config.users = config.users.filter((u) => u.id !== userId);
    this.save(platform, config);
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

/** The whole inbound permission policy. A group denial is silent by contract;
 *  a DM is the exception, and the adapter answers `not-bound` there. */
export function gate({ policy, isDm, addressed, bound, bindRequest }: GateInput): GateVerdict {
  if (!policy.enabled) return "chat-disabled";
  // In a DM bind is not optional: it is the only thing between a stranger and
  // an agent with a shell. `requireMention`/`requireBind` are group settings.
  if (isDm) return bound || bindRequest ? "allow" : "not-bound";
  if (policy.requireMention && !addressed) return "not-addressed";
  if (policy.requireBind && !bound && !bindRequest) return "not-bound";
  return "allow";
}
