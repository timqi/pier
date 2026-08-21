// Durable conversation → session routing for IM channels.
//
// core/router.ts keeps its map in memory, which is enough for the surfaces
// whose conversation id already IS a session id (web) or that persist their
// target themselves (tasks). An IM conversation id is a chat or a topic, so
// without this table a restart would silently hand every group a brand-new
// session: the chat history stays on screen while the agent forgets all of
// it, and the old transcript becomes unreachable.
//
// Owned by channels/ rather than core/ so core stays storage-agnostic — the
// same split tasks/ already uses for its target session ids.

import type { DatabaseSync } from "node:sqlite";
import type { AgentLaunchOptions, ConversationKey } from "../core/types.js";
import { defaultChannelDbPath, openChannelDb } from "./db.js";

export class ConversationStore {
  private readonly db: DatabaseSync;

  constructor(path = defaultChannelDbPath()) {
    this.db = openChannelDb(path, `
      CREATE TABLE IF NOT EXISTS conversations (
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, conversation_id)
      );
    `);
  }

  get(key: ConversationKey): string | undefined {
    const row = this.db.prepare(`
      SELECT session_id FROM conversations WHERE channel_id = ? AND conversation_id = ?
    `).get(key.channelId, key.conversationId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  set(key: ConversationKey, sessionId: string): void {
    this.db.prepare(`
      INSERT INTO conversations(channel_id, conversation_id, session_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id, conversation_id) DO UPDATE SET
        session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(key.channelId, key.conversationId, sessionId, Date.now());
  }

  /** Drop a mapping whose session Pi no longer has, so the next message
   * starts a fresh one instead of failing forever. */
  forget(key: ConversationKey): void {
    this.db.prepare(`
      DELETE FROM conversations WHERE channel_id = ? AND conversation_id = ?
    `).run(key.channelId, key.conversationId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The IM half of the router's session factory: reuse this conversation's
 * session across restarts, and only create when there is nothing to resume.
 * Wired in main.ts, so neither core nor an adapter learns where the mapping
 * lives.
 */
export function resolveConversation<S extends { id: string }>(
  store: ConversationStore,
  factory: {
    resume(sessionId: string): Promise<S>;
    create(opts: AgentLaunchOptions): Promise<S>;
  },
  launchFor: (key: ConversationKey) => Partial<AgentLaunchOptions>,
  onStale?: (message: string) => void,
): (key: ConversationKey) => Promise<S> {
  return async (key) => {
    const known = store.get(key);
    if (known) {
      try {
        return await factory.resume(known);
      } catch (err) {
        // Pi never persisted it (a first turn that never landed) or the
        // transcript was deleted. Re-route rather than fail every message.
        onStale?.(`${key.channelId}:${key.conversationId} lost session ${known}: ${String(err)}`);
        store.forget(key);
      }
    }
    const launch = launchFor(key);
    const session = await factory.create({ ...launch, cwd: launch.cwd ?? process.cwd() });
    store.set(key, session.id);
    return session;
  };
}
