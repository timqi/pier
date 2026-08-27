// What an adapter is allowed to do to a session, beyond handing it a prompt.
//
// `Channel` has exactly one inbound path (`onMessage`) and keeps it: an in-chat
// settings panel needs to read a session's model and change it, which is not a
// prompt and must not become a second seam. So the channel layer — which owns
// the router already — hands adapters this narrow, platform-blind interface.
// Everything here is a thin wrapper over core; no policy lives in it.

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

/** Everything an in-chat panel reads out. Absent when nothing is attached. */
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
  /** Launch options for a conversation's session, from its chat config. */
  launchFor(key: ConversationKey): Partial<AgentLaunchOptions>;
  /**
   * Has this conversation ever had a session? Durable, so it still answers
   * after a restart.
   *
   * Slack needs it to decide whether a message is *addressed*: a reply inside
   * a thread Pier already owns is continuing a conversation, which is Slack's
   * equivalent of Telegram's "replying to the bot". Adapter-instance memory
   * cannot answer that question across the reload the Console triggers.
   */
  knows(key: ConversationKey): boolean;
  abort(key: ConversationKey): Promise<void>;
  status(key: ConversationKey): Promise<ConversationStatus | null>;
  models(): Promise<ModelRef[]>;
  setModel(key: ConversationKey, model: ModelRef): Promise<void>;
  setThinking(key: ConversationKey, level: ThinkingLevel): Promise<void>;
  /**
   * Point the conversation at a brand-new session. Pi fixes cwd at creation, so
   * "change the working directory" *is* "start a new session there" — one
   * action, and the panel says so.
   */
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
    // Decoding a conversation id back to a chat id is the channel layer's
    // business, never core's; the chat half of every platform's id has one
    // decoder (chatOf), so no adapter import is needed here.
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
      // AgentSession has no cwd; the factory's listing is where it lives.
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
      // Persist before attaching: a crash in between must not leave the chat
      // pointing at a session nobody recorded.
      conversations.set(key, session.id);
      router.attach(key, session);
      return session.id;
    },
  };
}
