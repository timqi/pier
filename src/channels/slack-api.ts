// Thin Slack client: HTTP shapes and the Socket Mode transport, no policy; the
// one file that talks to slack.com. Socket Mode so Pier needs no public inbound
// URL: the app-level token (`xapp-`) opens the socket, the bot token (`xoxb-`)
// signs every Web API call. No SDK: `apps.connections.open` plus Node's
// WebSocket is the whole protocol.

import { readCapped } from "../core/inbox.js";

const BASE = "https://slack.com/api";

export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number; // bytes — checked against MAX_INBOUND_BYTES before download
  url_private_download?: string;
  url_private?: string;
}

/** Slack flattens these onto the attachment, and some shares nest the original
 *  under `original_message` instead; both are read. */
export interface SharedMessage {
  text?: string;
  ts?: string;
  thread_ts?: string;
  /** Only when the shared message is a thread parent. */
  reply_count?: number;
  files?: SlackFile[];
}

/** A forwarded message. None of these fields is in Slack's published types;
 *  they are what a share actually arrives with. */
export interface SlackAttachment extends SharedMessage {
  /** The share flag proper; the `message_share` subtype may arrive without it. */
  is_share?: boolean;
  /** Set on a real share too, so it can only rule a share out (`sharesOf`). */
  is_msg_unfurl?: boolean;
  /** Absent on some shares, which give only a name. */
  author_id?: string;
  author_name?: string;
  author_subname?: string;
  channel_id?: string;
  /** Bare, without the `#`. */
  channel_name?: string;
  /** A plain-text rendering of the message, when `text` is empty. */
  fallback?: string;
  original_message?: SharedMessage;
}

/** The subset of a `message` event the adapter reads. */
export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string; // "im" | "mpim" | "channel" | "group"
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  /** Only on a thread parent in `conversations.history`. */
  reply_count?: number;
  files?: SlackFile[];
  /** Secondary attachments; a forwarded message arrives as one of these. */
  attachments?: SlackAttachment[];
}

export interface SlackEventPayload {
  event_id?: string;
  event?: SlackMessageEvent;
}

export interface SlackButton {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string; emoji: true };
}

export type SlackBlock =
  /** Rendered by Slack itself (tables, headers, nested lists) and not collapsed
   *  behind "Show more". 12,000 chars cumulative per message. */
  | { type: "markdown"; text: string }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | { type: "actions"; elements: SlackButton[] };

/** Slack echoes the whole message with a click. */
export interface SlackInteraction {
  type: string; // "block_actions" | "view_submission"
  trigger_id?: string;
  user?: { id: string };
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string; blocks?: SlackBlock[] };
  actions?: { action_id: string }[];
  view?: SlackView;
}

export interface SlackView {
  callback_id?: string;
  private_metadata?: string;
  state?: { values: Record<string, Record<string, { value?: string | null }>> };
}


/** `hello` and `disconnect` are handled by the transport; everything else
 *  reaches the adapter already acked. */
export interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  reason?: string;
  payload?: unknown;
}

export interface SlackSend {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: SlackBlock[];
  /** Both off on every send: three URLs would grow three preview cards taller
   *  than the answer. */
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface SlackHistoryPage {
  messages: SlackMessageEvent[];
  nextCursor?: string;
}

export interface SlackHistoryQuery {
  /** Slack `ts` bounds, inclusive-ish; Slack treats them as exclusive. */
  oldest?: string;
  latest?: string;
  limit?: number;
  cursor?: string;
}

/** `close()` stops it reconnecting. */
export interface SlackSocket {
  close(): Promise<void>;
}

/** The part of `WebSocket` the transport uses, so the reconnect loop is testable. */
export interface SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** Every call the adapter makes — the seam a test double implements. */
export interface SlackClient {
  authTest(): Promise<{ userId: string }>;
  /** Envelopes are acked by the transport *before* `onEnvelope` runs: a turn
   *  outlives Slack's ack deadline, and an unacked envelope is redelivered. */
  connect(onEnvelope: (env: SlackEnvelope) => void): Promise<SlackSocket>;
  postMessage(payload: SlackSend): Promise<{ ts: string }>;
  updateMessage(payload: SlackSend & { ts: string }): Promise<void>;
  deleteMessage(channel: string, ts: string): Promise<void>;
  setBlocks(channel: string, ts: string, text: string, blocks: SlackBlock[]): Promise<void>;
  /** `name` is a short name (`eyes`); Slack rejects a raw codepoint. */
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  openView(triggerId: string, view: unknown): Promise<void>;
  channelInfo(channel: string): Promise<{ name?: string; isIm: boolean }>;
  userName(userId: string): Promise<string>;
  /** Newest first — how Slack orders it. */
  history(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage>;
  /** The parent message followed by its replies, oldest first. */
  replies(channel: string, ts: string, query: SlackHistoryQuery): Promise<SlackHistoryPage>;
  /** Needs the `files:read` scope. */
  filesInfo(id: string): Promise<SlackFile>;
  downloadFile(file: SlackFile, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Needs the `files:write` scope. */
  uploadFile(
    channel: string,
    threadTs: string,
    file: { name: string; bytes: Uint8Array },
  ): Promise<void>;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** A workspace that predates the `markdown` block answers with one of these;
 *  there is no capability API, so a failed send is the only detection. The
 *  caller latches the answer for the process, so the match must stay narrow:
 *  `invalid_arguments` is deliberately not matched — a malformed `thread_ts`
 *  would otherwise permanently downgrade the renderer. */
export const isBlockRejection = (err: unknown): boolean =>
  /invalid_blocks|unsupported_block_type/.test(String(err));

/** Younger than this was a failed attempt: Slack answers "too many
 *  connections" by accepting the socket and closing it straight away. */
const MIN_CONNECTION_MS = 5000;
const RECONNECT_FLOOR_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class SlackApi implements SlackClient {
  private socketRunning = false;

  constructor(
    private readonly token: string,
    private readonly appToken: string,
    private readonly log: (message: string) => void = () => {},
    /** Injected in tests. */
    private readonly openSocket: SocketFactory = (url) => new WebSocket(url) as SocketLike,
  ) {}

  /** Slack accepts a JSON body only on write methods; a read method silently
   *  ignores it and reports the parameter missing (`users.info` answers
   *  `user_not_found`). So reads go form-encoded. */
  private async read<T extends SlackResponse>(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    return this.call<T>(method, form);
  }

  private async call<T extends SlackResponse>(
    method: string,
    payload: unknown,
    token = this.token,
    retry = true,
  ): Promise<T> {
    const form = payload instanceof URLSearchParams;
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: {
        "content-type": form
          ? "application/x-www-form-urlencoded; charset=utf-8"
          : "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: form ? payload.toString() : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    // A long turn split into chunks hits ~1 msg/s per channel; the header
    // carries the exact wait. Obeyed once; a second 429 throws.
    if (res.status === 429 && retry) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      if (Number.isFinite(after) && after <= 60) {
        await new Promise((r) => setTimeout(r, (after + 1) * 1000));
        return this.call<T>(method, payload, token, false);
      }
    }
    const body = (await res.json().catch(() => null)) as T | null;
    if (!body) throw new Error(`slack ${method}: ${res.status} with no JSON body`);
    if (!body.ok) throw new Error(`slack ${method}: ${body.error ?? res.status}`);
    return body;
  }

  async authTest(): Promise<{ userId: string }> {
    const body = await this.call<SlackResponse & { user_id?: string }>("auth.test", {});
    return { userId: body.user_id ?? "" };
  }

  // --- Socket Mode -----------------------------------------------------------

  /** Slack cycles a connection every few hours with `disconnect:
   *  refresh_requested`, so the loop reopens until `close()` clears the flag. */
  async connect(onEnvelope: (env: SlackEnvelope) => void): Promise<SlackSocket> {
    this.socketRunning = true;
    let socket: SocketLike | undefined;
    const run = async (): Promise<void> => {
      let backoff = RECONNECT_FLOOR_MS;
      while (this.socketRunning) {
        // Set once the socket exists, not before `apps.connections.open`.
        let connectedAt = 0;
        try {
          const open = await this.call<SlackResponse & { url?: string }>(
            "apps.connections.open",
            {},
            this.appToken,
          );
          if (!open.url) throw new Error("apps.connections.open returned no url");
          // stop() may have landed while that call was in flight.
          if (!this.socketRunning) return;
          socket = this.openSocket(open.url);
          connectedAt = Date.now();
          // Resolves on close, never rejects: a dropped socket is normal.
          await new Promise<void>((resolve) => {
            const ws = socket!;
            ws.onmessage = (ev: { data: unknown }) => {
              let env: SlackEnvelope;
              try {
                env = JSON.parse(String(ev.data)) as SlackEnvelope;
              } catch {
                this.log(`unparseable socket frame dropped`);
                return;
              }
              // Ack first: a turn outlives the deadline, and an unacked
              // envelope is redelivered.
              if (env.envelope_id) {
                try {
                  ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
                } catch (err) {
                  this.log(`ack failed: ${String(err)}`);
                }
              }
              if (env.type === "hello") return;
              if (env.type === "disconnect") {
                this.log(`socket disconnect (${env.reason ?? "no reason"}), reconnecting`);
                ws.close();
                return;
              }
              onEnvelope(env);
            };
            ws.onerror = () => {
              // `onclose` always follows, and carries the useful detail.
            };
            ws.onclose = () => resolve();
          });
        } catch (err) {
          this.log(`socket connect failed: ${String(err)}`);
        }
        if (!this.socketRunning) return;
        // A socket that lived a while was healthy; one that died young backs off.
        if (connectedAt && Date.now() - connectedAt >= MIN_CONNECTION_MS) {
          backoff = RECONNECT_FLOOR_MS;
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    };
    void run();
    return {
      close: async () => {
        this.socketRunning = false;
        try {
          socket?.close();
        } catch {
          // Already closing; nothing to recover.
        }
      },
    };
  }

  // --- messages --------------------------------------------------------------

  async postMessage(payload: SlackSend): Promise<{ ts: string }> {
    const body = await this.call<SlackResponse & { ts?: string }>("chat.postMessage", {
      unfurl_links: false,
      unfurl_media: false,
      ...payload,
    });
    return { ts: body.ts ?? "" };
  }

  async updateMessage(payload: SlackSend & { ts: string }): Promise<void> {
    // chat.update takes no thread_ts; sending it is an invalid_arguments error.
    const { thread_ts: _thread, ...rest } = payload;
    await this.call("chat.update", rest);
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    await this.call("chat.delete", { channel, ts });
  }

  async setBlocks(channel: string, ts: string, text: string, blocks: SlackBlock[]): Promise<void> {
    await this.call("chat.update", { channel, ts, text, blocks });
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call("reactions.add", { channel, timestamp: ts, name });
    } catch (err) {
      if (!String(err).includes("already_reacted")) throw err;
    }
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call("reactions.remove", { channel, timestamp: ts, name });
    } catch (err) {
      if (!String(err).includes("no_reaction")) throw err;
    }
  }

  async openView(triggerId: string, view: unknown): Promise<void> {
    await this.call("views.open", { trigger_id: triggerId, view });
  }

  async channelInfo(channel: string): Promise<{ name?: string; isIm: boolean }> {
    const body = await this.read<
      SlackResponse & { channel?: { name?: string; is_im?: boolean; is_mpim?: boolean } }
    >("conversations.info", { channel });
    return {
      name: body.channel?.name,
      isIm: !!(body.channel?.is_im || body.channel?.is_mpim),
    };
  }

  async userName(userId: string): Promise<string> {
    const body = await this.read<
      SlackResponse & { user?: { real_name?: string; name?: string } }
    >("users.info", { user: userId });
    return body.user?.real_name || body.user?.name || userId;
  }

  private async page(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<SlackHistoryPage> {
    const body = await this.read<
      SlackResponse & {
        messages?: SlackMessageEvent[];
        response_metadata?: { next_cursor?: string };
      }
    >(method, params);
    // Slack sends `""` for "no more" rather than omitting it.
    const next = body.response_metadata?.next_cursor;
    return { messages: body.messages ?? [], nextCursor: next || undefined };
  }

  history(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    return this.page("conversations.history", {
      channel,
      oldest: query.oldest,
      latest: query.latest,
      limit: query.limit ?? 200,
      cursor: query.cursor,
      inclusive: true,
    });
  }

  replies(channel: string, ts: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    return this.page("conversations.replies", {
      channel,
      ts,
      // Slack drops the boundary message unless asked; the caller filters for itself.
      oldest: query.oldest,
      inclusive: true,
      limit: query.limit ?? 200,
      cursor: query.cursor,
    });
  }

  async filesInfo(id: string): Promise<SlackFile> {
    const body = await this.read<SlackResponse & { file?: SlackFile }>("files.info", { file: id });
    if (!body.file) throw new Error("slack files.info: no file in the response");
    return body.file;
  }

  /** File URLs need the bot token as a bearer header, and answer HTML (a login
   *  page) rather than an error without it. */
  async downloadFile(file: SlackFile, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = file.url_private_download ?? file.url_private;
    if (!url) throw new Error("slack file has no private url");
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`slack file download: ${res.status}`);
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? file.mimetype ?? "application/octet-stream";
    return { bytes: await readCapped(res.body, maxBytes), mimeType };
  }

  /** Three calls is Slack's current upload (`files.upload` is retired); the
   *  upload host is not the Web API and answers plain text. */
  async uploadFile(
    channel: string,
    threadTs: string,
    file: { name: string; bytes: Uint8Array },
  ): Promise<void> {
    const slot = await this.read<SlackResponse & { upload_url?: string; file_id?: string }>(
      "files.getUploadURLExternal",
      { filename: file.name, length: file.bytes.length },
    ).catch((err: unknown) => {
      // The manifest is only applied when an app is created; name the fix.
      if (!/missing_scope/.test(String(err))) throw err;
      throw new Error(
        "the Slack app is missing the files:write scope — add it under " +
          "OAuth & Permissions and reinstall the app",
      );
    });
    if (!slot.upload_url || !slot.file_id) {
      throw new Error("slack files.getUploadURLExternal: no upload url");
    }
    const put = await fetch(slot.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      // A request body must be backed by an ArrayBuffer, not a Buffer's ArrayBufferLike.
      body: new Uint8Array(file.bytes),
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) throw new Error(`slack file upload: ${put.status}`);
    await this.call("files.completeUploadExternal", {
      files: [{ id: slot.file_id, title: file.name }],
      channel_id: channel,
      thread_ts: threadTs,
    });
  }
}
