// What an adapter may do to a session beyond handing it a prompt. Not part of
// the `Channel` seam: the channel layer owns the router and hands adapters this
// narrow interface instead. Thin wrappers over core; no policy.

import { projectCwds } from "../core/identity.js";
import type { Router } from "../core/router.js";
import type {
  AgentFactory,
  AgentLaunchOptions,
  AgentSession,
  ConversationKey,
  ModelRef,
  SessionState,
  ThinkingLevel,
} from "../core/types.js";
import type { ModelMenuEntry } from "../settings.js";
import type { ChannelStore } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import { chatOf, isChannelPlatform } from "./types.js";

export const NO_SESSION = "No session in this thread yet — start one first (Start in the panel).";
export const HAS_SESSION = "This thread already has a session — send your question as a message.";

export interface ConversationStatus {
  sessionId: string;
  cwd: string;
  state: SessionState;
  /** No turn in the transcript yet: the panel says "created, no message yet". */
  empty: boolean;
  model: ModelRef | undefined;
  thinking: ThinkingLevel;
  tokens: number | null;
  contextWindow: number | null;
}

export interface ChannelControl {
  launchFor(key: ConversationKey): Partial<AgentLaunchOptions>;
  /** Has this conversation ever had a session? Durable: a reply inside a
   *  thread Pier owns is addressed, and that must hold across a reload. */
  knows(key: ConversationKey): boolean;
  abort(key: ConversationKey): Promise<void>;
  /** Null when the thread has no session; an evicted one is resumed, never
   *  answered null. */
  status(key: ConversationKey): Promise<ConversationStatus | null>;
  /** The operator's pinned models, the same list `pier task --model ?` prints. */
  pins(): ModelMenuEntry[];
  /** Rejects with NO_SESSION for a thread without one: a confirmed no-op is a lie. */
  setModel(key: ConversationKey, model: ModelRef): Promise<void>;
  setThinking(key: ConversationKey, level: ThinkingLevel): Promise<void>;
  /** `over` carries only what was chosen; the chat defaults fill the rest.
   *  The launch is recorded beside the row: Pi writes nothing until the first
   *  reply, so until then the record is the session. */
  newSession(key: ConversationKey, over?: Partial<AgentLaunchOptions>): Promise<string>;
  /** Distinct cwds of the backend's session listing, newest first; the chat's
   *  own default first when set. */
  recentDirs(key: ConversationKey, limit?: number): Promise<string[]>;
  /** The last `exchanges` user turns of the thread's transcript, each with the
   *  reply that followed it, oldest → newest; texts as stored. Empty for a
   *  thread without a session, as `status` is null for one. */
  recent(key: ConversationKey, exchanges: number): Promise<{ user: string; assistant?: string }[]>;
}

export interface ControlDeps {
  router: Router;
  factory: AgentFactory;
  conversations: ConversationStore;
  store: ChannelStore;
  modelMenu: () => ModelMenuEntry[];
}

export function createControl({ router, factory, conversations, store, modelMenu }: ControlDeps): ChannelControl {
  const launchFor = (key: ConversationKey): Partial<AgentLaunchOptions> => {
    if (!isChannelPlatform(key.channelId)) return {};
    const policy = store.policy(key.channelId, chatOf(key.conversationId));
    return {
      cwd: policy.cwd || undefined,
      model: policy.model ?? undefined,
      thinking: policy.thinking ?? undefined,
    };
  };

  /** The thread's session, resumed if evicted; undefined when the thread has
   *  none. Never creates: a look at the panel must not open a session. */
  const live = async (key: ConversationKey): Promise<AgentSession | undefined> => {
    if (!conversations.get(key)) return undefined;
    return router.sessionOf(key) ?? router.ensure(key);
  };

  return {
    launchFor,

    knows: (key) => conversations.get(key) !== undefined,

    abort: (key) => router.abortConversation(key),

    async status(key) {
      const session = await live(key);
      if (!session) return null;
      const summary = await factory.find(session.id);
      const usage = session.contextUsage;
      return {
        sessionId: session.id,
        // Not on disk until its first reply; the launch record knows where it is.
        cwd: summary?.cwd ?? conversations.launchOf(key)?.cwd ?? "",
        state: session.state,
        empty: (await session.history()).length === 0,
        model: session.model,
        thinking: session.thinkingLevel,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
      };
    },

    pins: modelMenu,

    async setModel(key, model) {
      const session = await live(key);
      if (!session) throw new Error(NO_SESSION);
      await session.setModel(model);
      conversations.amendLaunch(key, { model });
    },

    async setThinking(key, level) {
      const session = await live(key);
      if (!session) throw new Error(NO_SESSION);
      session.setThinkingLevel(level);
      conversations.amendLaunch(key, { thinking: level });
    },

    async newSession(key, over = {}) {
      const defaults = launchFor(key);
      const launch: AgentLaunchOptions = { ...defaults, ...over, cwd: over.cwd || defaults.cwd || process.cwd() };
      const session = await factory.create(launch);
      // A message already inside the router's resolve can write the row while Pi
      // was opening: the first row wins, and the session nobody routes to goes.
      if (conversations.get(key)) {
        await session.dispose();
        throw new Error(HAS_SESSION);
      }
      // Persist before attaching: a crash between must not leave an unrecorded session.
      conversations.set(key, session.id, launch);
      router.attach(key, session);
      return session.id;
    },

    async recentDirs(key, limit = 6) {
      const own = launchFor(key).cwd;
      // The web's rule (worktrees folded into their project); task runs' directories count too.
      const seen = new Set<string>([...(own ? [own] : []), ...projectCwds(await factory.list())]);
      return [...seen].slice(0, limit);
    },

    async recent(key, exchanges) {
      const session = await live(key);
      if (!session) return [];
      const pairs: { user: string; assistant?: string }[] = [];
      for (const turn of await session.history()) {
        const last = pairs.at(-1);
        if (turn.role === "user") pairs.push({ user: turn.text });
        // The first reply after a user turn; later assistant turns of the same
        // exchange are continuations of the same answer.
        else if (turn.role === "assistant" && last && last.assistant === undefined) last.assistant = turn.text;
      }
      return pairs.slice(-exchanges);
    },
  };
}
