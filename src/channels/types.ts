// IM channel configuration types — the wire contract shared by the store, the
// adapters and the Console view (type-only, so no node builtins here). Defaults
// are least-privilege, and platform values are seeds copied into a chat on
// discovery, not a runtime fallback: a switch means what it says.

import type { ModelRef, ThinkingLevel } from "../core/types.js";

export type ChannelPlatform = "slack" | "lark";

const PLATFORMS: readonly string[] = ["slack", "lark"];

/** Validate at the boundary: an unknown platform is a 404, not a new row. */
export const isChannelPlatform = (v: unknown): v is ChannelPlatform =>
  typeof v === "string" && PLATFORMS.includes(v);

/** Every adapter spells its ids `<chatId>` or `<chatId>/<thread>`, so the chat
 *  half has one decoder; the thread half genuinely differs per platform. */
export const chatOf = (conversationId: string): string =>
  conversationId.split("/", 1)[0] ?? "";

/** A DM or a group; both platforms thread inside either. */
export type ChatKind = "dm" | "group";

export interface ChatConfig {
  id: string;
  name: string;
  kind: ChatKind;
  enabled: boolean;
  requireMention: boolean;
  requireBind: boolean;
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
  /** Wrong redeems so far; enough of them void the code before its TTL. */
  tries?: number;
}

/** What a `/bind <code>` attempt did: bound the sender, was wrong, or was the
 *  wrong try that voided the code — which the sender is told. */
export type BindOutcome = "bound" | "invalid" | "voided";

/** Platform-level values double as the seed for newly discovered chats. */
export interface ChannelConfig {
  enabled: boolean;
  /** The platform's primary credential: Slack's bot token (`xoxb-`), Lark's
   *  App ID (`cli_…`). */
  token: string;
  /**
   * Second credential; both platforms authenticate with a pair. Slack Socket
   * Mode needs an app-level token (`xapp-`) beside the bot token; Lark signs
   * everything with App ID + App Secret, and this is the secret.
   */
  appToken: string;
  requireMention: boolean;
  requireBind: boolean;
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
  appToken: "",
  requireMention: true,
  requireBind: true,
  cwd: "",
  model: null,
  thinking: null,
  users: [],
  chats: [],
  bindCode: null,
});
