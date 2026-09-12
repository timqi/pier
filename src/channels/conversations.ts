// Durable conversation → session routing for IM channels: an IM conversation id
// is a chat, not a session id, so without this table a restart would hand every
// group a brand-new session. In channels/ so core stays storage-agnostic.

import type { DatabaseSync } from "node:sqlite";
import type { AgentLaunchOptions, ConversationKey } from "../core/types.js";
import { pierDb } from "../db.js";

export class ConversationStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.db = db;
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

  /** Durable, unlike the router's answer, which is gone once an idle session
   *  is evicted. No row: nobody's conversation. */
  channelOf(sessionId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT channel_id FROM conversations WHERE session_id = ? LIMIT 1
    `).get(sessionId) as { channel_id: string } | undefined;
    return row?.channel_id;
  }

  forget(key: ConversationKey): void {
    this.db.prepare(`
      DELETE FROM conversations WHERE channel_id = ? AND conversation_id = ?
    `).run(key.channelId, key.conversationId);
  }

}

/** The IM half of the router's session factory, wired in main.ts so neither
 *  core nor an adapter learns where the mapping lives. */
export function resolveConversation<S extends { id: string }>(
  store: ConversationStore,
  factory: {
    resume(sessionId: string): Promise<S>;
    create(opts: AgentLaunchOptions): Promise<S>;
  },
  launchFor: (key: ConversationKey) => Partial<AgentLaunchOptions>,
  /** The thread is told, not only the log: its next answer comes from a
   *  session that remembers nothing. */
  onStale?: (key: ConversationKey, message: string) => void,
): (key: ConversationKey) => Promise<S> {
  return async (key) => {
    const known = store.get(key);
    let stale: string | undefined;
    if (known) {
      try {
        return await factory.resume(known);
      } catch (err) {
        // Never persisted, or deleted: re-route rather than fail every message.
        stale = `${known.slice(0, 8)} is gone from disk (${String(err)})`;
        store.forget(key);
      }
    }
    const launch = launchFor(key);
    const cwd = launch.cwd ?? process.cwd();
    const session = await factory.create({ ...launch, cwd });
    store.set(key, session.id);
    if (stale) onStale?.(key, `Session ${stale}; this thread continues in a new session in ${cwd}.`);
    return session;
  };
}
