// Web → IM handoff: the only code that binds an existing session to a thread it
// did not create, and the only root message Pier ever posts. Post before row —
// a row for a thread that does not exist is worse than a message with no row.

import { sessionLabel } from "../core/identity.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import type { AgentFactory, ConversationKey } from "../core/types.js";
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
  factory: Pick<AgentFactory, "find">;
  router: Pick<Router, "sessionOf" | "attach">;
  hub: Pick<EventHub, "emitWorkspace">;
  publicUrl: () => string;
  log(message: string): void;
}

export class HandoffError extends Error {
  constructor(readonly status: 404 | 409 | 502, message: string) {
    super(message);
  }
}

const platformName = (platform: string): string => platform[0]!.toUpperCase() + platform.slice(1);

export function createHandoff(deps: HandoffDeps): {
  targets(): HandoffTarget[];
  continueIn(req: HandoffRequest): Promise<HandoffResult>;
} {
  const { store, runtime, conversations, factory, router, hub, publicUrl, log } = deps;

  /** Where a session already answers, for the refusal: the chat's name, else its id. */
  const nameOf = (key: ConversationKey): string => {
    const chatId = chatOf(key.conversationId);
    return (isChannelPlatform(key.channelId) && store.chat(key.channelId, chatId)?.name) || chatId;
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
      const summary = await factory.find(sessionId);
      if (!summary) {
        throw new HandoffError(404, `Session ${sessionId.slice(0, 8)} has no transcript yet — send it one message first.`);
      }
      const bound = conversations.keyOf(sessionId);
      if (bound) throw new HandoffError(409, `Already answers in ${bound.channelId} · ${nameOf(bound)}.`);
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
      const key: ConversationKey = { channelId: platform, conversationId };
      conversations.set(key, sessionId);
      // Loaded on the web right now: the next turn answers in the thread
      // without waiting for the thread to speak. Not loaded: the row is enough.
      const live = router.sessionOf({ channelId: "web", conversationId: sessionId });
      if (live) router.attach(key, live);
      hub.emitWorkspace({ type: "sessions-changed" });
      log(`session ${sessionId} continued in ${platform}:${conversationId}`);
      return { conversationId };
    },
  };
}
