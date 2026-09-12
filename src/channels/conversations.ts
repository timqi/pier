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

  /** `launch` is what the session was created with, kept for the day Pi has
   *  no transcript to resume (a session never prompted was never written);
   *  omitted for one launched from the chat defaults, which a re-create reads
   *  again. */
  set(key: ConversationKey, sessionId: string, launch?: AgentLaunchOptions): void {
    this.db.prepare(`
      INSERT INTO conversations(channel_id, conversation_id, session_id, updated_at, launch)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, conversation_id) DO UPDATE SET
        session_id = excluded.session_id, updated_at = excluded.updated_at, launch = excluded.launch
    `).run(key.channelId, key.conversationId, sessionId, Date.now(), launch ? JSON.stringify(launch) : null);
  }

  launchOf(key: ConversationKey): AgentLaunchOptions | undefined {
    const row = this.db.prepare(`
      SELECT launch FROM conversations WHERE channel_id = ? AND conversation_id = ?
    `).get(key.channelId, key.conversationId) as { launch: string | null } | undefined;
    return row?.launch ? JSON.parse(row.launch) as AgentLaunchOptions : undefined;
  }

  /** Merge a model/reasoning change into the record, so a never-written
   *  session re-creates as last configured. No record: nothing to amend. */
  amendLaunch(key: ConversationKey, patch: Partial<Pick<AgentLaunchOptions, "model" | "thinking">>): void {
    const launch = this.launchOf(key);
    if (!launch) return;
    this.db.prepare(`
      UPDATE conversations SET launch = ? WHERE channel_id = ? AND conversation_id = ?
    `).run(JSON.stringify({ ...launch, ...patch }), key.channelId, key.conversationId);
  }

  /** Durable, unlike the router's answer, which is gone once an idle session
   *  is evicted. No row: nobody's conversation. */
  keyOf(sessionId: string): ConversationKey | undefined {
    const row = this.db.prepare(`
      SELECT channel_id, conversation_id FROM conversations WHERE session_id = ? LIMIT 1
    `).get(sessionId) as { channel_id: string; conversation_id: string } | undefined;
    return row && { channelId: row.channel_id, conversationId: row.conversation_id };
  }

  /** Every session some IM conversation answers for — one query, so a listing
   *  can be filtered without asking `keyOf` per row. */
  boundSessions(): Set<string> {
    const rows = this.db.prepare(`SELECT session_id FROM conversations`).all() as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
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
    let recorded: AgentLaunchOptions | undefined;
    if (known) {
      try {
        return await factory.resume(known);
      } catch (err) {
        // Never persisted, or deleted: re-route rather than fail every message.
        stale = `${known.slice(0, 8)} is gone from disk (${String(err)})`;
        recorded = store.launchOf(key);
        store.forget(key);
      }
    }
    const defaults = launchFor(key);
    const launch = recorded ?? { ...defaults, cwd: defaults.cwd ?? process.cwd() };
    const session = await factory.create(launch);
    store.set(key, session.id, recorded);
    if (stale) {
      onStale?.(key, recorded
        ? `Session ${stale}; re-created as ${session.id.slice(0, 8)} with its own settings in ${launch.cwd}.`
        : `Session ${stale}; this thread continues in a new session with the chat defaults in ${launch.cwd}.`);
    }
    return session;
  };
}
