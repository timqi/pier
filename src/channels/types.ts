// IM channel configuration types — the wire contract shared by the store, the
// adapters and the Console view (which type-only imports it, so this file must
// stay free of node builtins, exactly like core/types.ts).
//
// Defaults are least-privilege: mention AND bind are required. The platform
// values are *seeds*, copied into a chat when the bot first sees it — not a
// fallback consulted at runtime. So every chat carries its own answer and a
// switch means what it says, instead of a three-state "inherit" nobody can
// read off the screen.

import type { ModelRef, ThinkingLevel } from "../core/types.js";

export type ChannelPlatform = "telegram" | "slack" | "lark";

const PLATFORMS: readonly string[] = ["telegram", "slack", "lark"];

/** Validate at the boundary: an unknown platform is a 404, not a new row. */
export const isChannelPlatform = (v: unknown): v is ChannelPlatform =>
  typeof v === "string" && PLATFORMS.includes(v);

/** A DM, a plain group, or a group with native sub-threads (Telegram forum). */
export type ChatKind = "dm" | "group" | "forum";

export interface ChatConfig {
  id: string;
  name: string;
  kind: ChatKind;
  enabled: boolean;
  requireMention: boolean;
  requireBind: boolean;
  topicMode: boolean;
  /** Where this chat's sessions start; seeded from the platform default. */
  cwd: string;
  /** null → whatever Pi would pick for a new session. */
  model: ModelRef | null;
  /** null → the project/Pi default. Pi clamps a level a model cannot do. */
  thinking: ThinkingLevel | null;
}

export interface BoundUser {
  id: string;
  name: string;
  boundAt: number;
}

export interface BindCode {
  code: string;
  expiresAt: number;
}

/** Platform-level values double as the seed for newly discovered chats. */
export interface ChannelConfig {
  enabled: boolean;
  token: string;
  requireMention: boolean;
  requireBind: boolean;
  topicMode: boolean;
  /** "" → the pier process cwd. */
  cwd: string;
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  users: BoundUser[];
  chats: ChatConfig[];
  bindCode: BindCode | null;
}

/** What the runtime asks about one chat. */
export type ChatPolicy = Omit<ChatConfig, "id" | "name" | "kind">;

export const defaultChannelConfig = (): ChannelConfig => ({
  enabled: false,
  token: "",
  requireMention: true,
  requireBind: true,
  topicMode: true,
  cwd: "",
  model: null,
  thinking: null,
  users: [],
  chats: [],
  bindCode: null,
});
