// What an adapter may do to a session beyond handing it a prompt. Not part of
// the `Channel` seam: the channel layer owns the router and hands adapters this
// narrow interface instead. Thin wrappers over core; no policy.

import type { Router } from "../core/router.js";
import type {
  AgentFactory,
  AgentLaunchOptions,
  ConversationKey,
  ModelRef,
  SessionState,
  ThinkingLevel,
} from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import { chatOf, isChannelPlatform } from "./types.js";

export interface ConversationStatus {
  sessionId: string;
  cwd: string;
  state: SessionState;
  model: ModelRef | undefined;
  thinking: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  tokens: number | null;
  contextWindow: number | null;
}

export interface ChannelControl {
  launchFor(key: ConversationKey): Partial<AgentLaunchOptions>;
  /** Has this conversation ever had a session? Durable: a reply inside a
   *  thread Pier owns is addressed, and that must hold across a reload. */
  knows(key: ConversationKey): boolean;
  abort(key: ConversationKey): Promise<void>;
  status(key: ConversationKey): Promise<ConversationStatus | null>;
  models(): Promise<ModelRef[]>;
  setModel(key: ConversationKey, model: ModelRef): Promise<void>;
  setThinking(key: ConversationKey, level: ThinkingLevel): Promise<void>;
  /** Pi fixes cwd at creation, so "change the working directory" *is* this. */
  newSession(key: ConversationKey, cwd?: string): Promise<string>;
}

export interface ControlDeps {
  router: Router;
  factory: AgentFactory;
  conversations: ConversationStore;
  store: ChannelStore;
}

export function createControl({ router, factory, conversations, store }: ControlDeps): ChannelControl {
  const launchFor = (key: ConversationKey): Partial<AgentLaunchOptions> => {
    if (!isChannelPlatform(key.channelId)) return {};
    const policy = store.policy(key.channelId, chatOf(key.conversationId));
    return {
      cwd: policy.cwd || undefined,
      model: policy.model ?? undefined,
      thinking: policy.thinking ?? undefined,
    };
  };

  return {
    launchFor,

    knows: (key) => conversations.get(key) !== undefined,

    abort: (key) => router.abortConversation(key),

    async status(key) {
      const session = router.sessionOf(key);
      if (!session) return null;
      const summary = await factory.find(session.id);
      const usage = session.contextUsage;
      return {
        sessionId: session.id,
        cwd: summary?.cwd ?? "",
        state: session.state,
        model: session.model,
        thinking: session.thinkingLevel,
        thinkingLevels: session.availableThinkingLevels(),
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
      };
    },

    models: () => factory.availableModels(),

    async setModel(key, model) {
      await router.sessionOf(key)?.setModel(model);
    },

    async setThinking(key, level) {
      router.sessionOf(key)?.setThinkingLevel(level);
    },

    async newSession(key, cwd) {
      const launch = launchFor(key);
      const session = await factory.create({
        ...launch,
        cwd: cwd || launch.cwd || process.cwd(),
      });
      // Persist before attaching: a crash between must not leave an unrecorded session.
      conversations.set(key, session.id);
      router.attach(key, session);
      return session.id;
    },
  };
}
