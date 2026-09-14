// Web ↔ IM handoff: the only code that binds an existing session to a thread it
// did not create — pushed from the web (a new thread, the only root message
// Pier ever posts; post before row, since a row for a thread that does not
// exist is worse than a message with no row) or pulled from a thread's panel.

import { sessionLabel } from "../core/identity.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import type { AgentFactory, ConversationKey, SessionSummary } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import type { ChannelRuntime } from "./runtime.js";
import {
  chatOf,
  type HandoffRequest,
  type HandoffResult,
  type HandoffTarget,
  isChannelPlatform,
} from "./types.js";

export interface HandoffDeps {
  store: ChannelStore;
  runtime: Pick<ChannelRuntime, "running" | "openThread">;
  conversations: ConversationStore;
  factory: Pick<AgentFactory, "find" | "list">;
  router: Pick<Router, "sessionOf" | "attach">;
  hub: Pick<EventHub, "emitWorkspace">;
  publicUrl: () => string;
  /** Sessions a task run created for itself; a picker offers only the operator's. */
  taskSessions: () => Set<string>;
  /** The web rail's working set (`rank`): the picker lists what the rail lists, in its order. */
  workingSet: () => Map<string, { rank?: number }>;
  log(message: string): void;
}

export class HandoffError extends Error {
  constructor(readonly status: 404 | 409 | 502, message: string) {
    super(message);
  }
}

const platformName = (platform: string): string => platform[0]!.toUpperCase() + platform.slice(1);

export interface Handoff {
  targets(): HandoffTarget[];
  /** Sessions no IM conversation answers for, newest first: what a thread may pull. */
  unbound(limit: number): Promise<SessionSummary[]>;
  /** Web → IM: open a thread in `chatId` and bind it. */
  continueIn(req: HandoffRequest): Promise<HandoffResult>;
  /** IM → web: bind the thread the panel is in; it must have no session. */
  continueHere(key: ConversationKey, sessionId: string): Promise<void>;
}

export function createHandoff(deps: HandoffDeps): Handoff {
  const { store, runtime, conversations, factory, router, hub, publicUrl, log } = deps;

  /** Where a session already answers, for the refusal: the chat's name, else its id. */
  const nameOf = (key: ConversationKey): string => {
    const chatId = chatOf(key.conversationId);
    return (isChannelPlatform(key.channelId) && store.chat(key.channelId, chatId)?.name) || chatId;
  };

  /** The guards both directions share: on disk, and nobody's yet. */
  const claimable = async (sessionId: string): Promise<SessionSummary> => {
    const summary = await factory.find(sessionId);
    if (!summary) {
      throw new HandoffError(404, `Session ${sessionId.slice(0, 8)} has no transcript yet — send it one message first.`);
    }
    const bound = conversations.keyOf(sessionId);
    if (bound) throw new HandoffError(409, `Already answers in ${bound.channelId} · ${nameOf(bound)}.`);
    return summary;
  };

  /** The one binding. Loaded on the web right now: the next turn answers in
   *  the thread without waiting for the thread to speak. Not loaded: the row
   *  is enough. */
  const bind = (key: ConversationKey, sessionId: string): void => {
    conversations.set(key, sessionId);
    const live = router.sessionOf({ channelId: "web", conversationId: sessionId });
    if (live) router.attach(key, live);
    hub.emitWorkspace({ type: "sessions-changed" });
    log(`session ${sessionId} continued in ${key.channelId}:${key.conversationId}`);
  };

  return {
    targets: () =>
      runtime.running().flatMap((platform) =>
        store.get(platform).chats
          .filter((chat) => chat.enabled)
          .map((chat) => ({ platform, chatId: chat.id, name: chat.name, kind: chat.kind }))
      ),

    async continueIn({ sessionId, platform, chatId }) {
      if (!runtime.running().includes(platform)) {
        throw new HandoffError(409, `${platformName(platform)} is not running — enable it in Settings → Channels.`);
      }
      const chat = store.chat(platform, chatId);
      if (!chat?.enabled) throw new HandoffError(chat ? 409 : 404, "That chat is not enabled for the bot.");
      const summary = await claimable(sessionId);
      const base = publicUrl();
      const note = {
        title: sessionLabel(summary),
        url: base ? `${base}/#/session/${encodeURIComponent(sessionId)}` : "",
      };
      let conversationId: string;
      try {
        conversationId = await runtime.openThread(platform, chatId, note);
      } catch (err) {
        throw new HandoffError(502, String(err));
      }
      bind({ channelId: platform, conversationId }, sessionId);
      return { conversationId };
    },

    async unbound(limit) {
      const bound = conversations.boundSessions();
      const owned = deps.taskSessions();
      const ranks = deps.workingSet();
      const rank = (id: string): number => ranks.get(id)?.rank ?? Infinity;
      return (await factory.list())
        .filter((s) => !bound.has(s.id) && !owned.has(s.id))
        .sort((a, b) => rank(a.id) - rank(b.id) || b.createdAt - a.createdAt)
        .slice(0, limit);
    },

    async continueHere(key, sessionId) {
      // The panel hides the button once a row exists, but a stale panel or a
      // message that raced the tap must not orphan the thread's session.
      if (conversations.get(key)) throw new HandoffError(409, "This thread already has a session.");
      await claimable(sessionId);
      bind(key, sessionId);
    },
  };
}
