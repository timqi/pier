// Thin Slack client: HTTP shapes and the Socket Mode transport, no policy.
// The one file in channels/ that talks to slack.com, so the adapter stays
// testable against `SlackClient`.
//
// Socket Mode, not the Events API over HTTP: Pier is one local process and must
// not require a public inbound URL. It needs two credentials — an app-level
// token (`xapp-`) opens the socket, the bot token (`xoxb-`) signs every Web API
// call — which is why ChannelConfig carries `appToken` beside `token`.
//
// No SDK: `apps.connections.open` plus Node's built-in WebSocket is the whole
// protocol, and @slack/socket-mode would pull a dependency tree to wrap it.

const BASE = "https://slack.com/api";

export interface SlackFile {
  id: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
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
  files?: SlackFile[];
}

export interface SlackEventPayload {
  event_id?: string;
  event?: SlackMessageEvent;
}

/** A Block Kit button, the only interactive element Pier renders. */
export interface SlackButton {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string; emoji: true };
}

export type SlackBlock =
  /**
   * Standard markdown, rendered by Slack itself — tables, headers and nested
   * lists included, none of which survive the mrkdwn subset. Also the only
   * body block the client does not collapse behind "Show more". 12,000 chars
   * cumulative per message.
   */
  | { type: "markdown"; text: string }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | { type: "actions"; elements: SlackButton[] };

/** What a button click posts back. Slack echoes the whole message with it. */
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


/**
 * One Socket Mode frame. `hello` and `disconnect` carry no envelope id and are
 * handled by the transport; everything else reaches the adapter already acked.
 */
export interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  reason?: string;
  payload?: unknown;
}

export interface SlackSend {
  channel: string;
  /** Always set by the adapter: a reply belongs in its thread, never the channel. */
  thread_ts?: string;
  text: string;
  blocks?: SlackBlock[];
  /**
   * Both off on every send. A turn that mentions three URLs would otherwise
   * grow three preview cards taller than the answer itself, and the agent
   * quoting a link is not a request to render it.
   */
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/** One page of `conversations.history` / `conversations.replies`. */
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

/** A live Socket Mode connection. `close()` stops it reconnecting. */
export interface SlackSocket {
  close(): Promise<void>;
}

/**
 * The part of `WebSocket` the transport uses. A seam, so the reconnect loop is
 * testable without a real socket — it is the one piece of this file with
 * behaviour worth pinning down rather than just payload shapes.
 */
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
  /** Who am I: the bot's own user id, needed for mention detection. */
  authTest(): Promise<{ userId: string }>;
  /**
   * Open Socket Mode and keep it open. Envelopes are acknowledged by the
   * transport *before* `onEnvelope` runs — a turn takes far longer than
   * Slack's ack deadline, and an unacked envelope is redelivered.
   */
  connect(onEnvelope: (env: SlackEnvelope) => void): Promise<SlackSocket>;
  postMessage(payload: SlackSend): Promise<{ ts: string }>;
  /** Panels are edited in place; a new message per click would bury the thread. */
  updateMessage(payload: SlackSend & { ts: string }): Promise<void>;
  deleteMessage(channel: string, ts: string): Promise<void>;
  /** Retire a used button row without touching the text. */
  setBlocks(channel: string, ts: string, text: string, blocks: SlackBlock[]): Promise<void>;
  /** `name` is a short name (`eyes`); Slack rejects a raw codepoint. */
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  /** A modal is Slack's way to ask for one typed answer. */
  openView(triggerId: string, view: unknown): Promise<void>;
  channelInfo(channel: string): Promise<{ name?: string; isIm: boolean }>;
  userName(userId: string): Promise<string>;
  /** Channel timeline, newest first — how Slack orders it. */
  history(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage>;
  /** One thread: the parent message followed by its replies, oldest first. */
  replies(channel: string, ts: string, query: SlackHistoryQuery): Promise<SlackHistoryPage>;
  downloadFile(file: SlackFile): Promise<{ data: string; mimeType: string }>;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Did Slack refuse the payload because of the *block* itself? The `markdown`
 * block is recent, so a workspace that predates it answers with one of these —
 * the signal to re-render the turn as legacy mrkdwn rather than to lose it.
 *
 * Slack has no capability API to ask up front, so the only detection is a
 * failed send. That makes the test's *narrowness* the whole safety property:
 * the caller latches the answer for the process, so anything matched here
 * degrades every later message too. `invalid_arguments` is deliberately NOT
 * matched even though avibe lists it — avibe retries per message, where a
 * broad match costs one fallback; latching turns the same breadth into a
 * permanent downgrade triggered by an unrelated bad argument (a malformed
 * `thread_ts` would silently cost the whole process its rendering). A wrong
 * call should surface as an error, not as a quieter renderer.
 */
export const isBlockRejection = (err: unknown): boolean =>
  /invalid_blocks|unsupported_block_type/.test(String(err));

/**
 * A connection that dies younger than this was a failed attempt, however it
 * ended: Slack answers "too many connections" by accepting the socket and
 * closing it straight away, which is not an error the loop would otherwise see.
 */
const MIN_CONNECTION_MS = 5000;
const RECONNECT_FLOOR_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class SlackApi implements SlackClient {
  private socketRunning = false;

  constructor(
    private readonly token: string,
    private readonly appToken: string,
    private readonly log: (message: string) => void = () => {},
    /** Injected in tests; production opens a real WebSocket. */
    private readonly openSocket: SocketFactory = (url) => new WebSocket(url) as SocketLike,
  ) {}

  /**
   * Slack accepts a JSON body only on *write* methods. A read method
   * (`users.info`, `conversations.info|history|replies`) silently ignores it and
   * then reports the missing parameter — `users.info` answers `user_not_found`,
   * which reads like "no such person" rather than "you sent the id in a place I
   * do not look". So reads go form-encoded. This was worth four broken calls.
   */
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
    // Slack answers a flood (a long turn split into chunks hits ~1 msg/s per
    // channel) with the exact wait in a header. Obeying it once turns a dropped
    // reply into a late one; a second 429 is a real problem and throws.
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

  /**
   * Reconnecting is part of the protocol, not the adapter's problem: Slack
   * cycles a connection every few hours with `disconnect: refresh_requested`,
   * so the loop reopens until `close()` clears the flag.
   */
  async connect(onEnvelope: (env: SlackEnvelope) => void): Promise<SlackSocket> {
    this.socketRunning = true;
    let socket: SocketLike | undefined;
    const run = async (): Promise<void> => {
      let backoff = RECONNECT_FLOOR_MS;
      while (this.socketRunning) {
        // Set once the socket exists, so a slow `apps.connections.open` cannot
        // make a connection that died instantly look like a healthy one.
        let connectedAt = 0;
        try {
          const open = await this.call<SlackResponse & { url?: string }>(
            "apps.connections.open",
            {},
            this.appToken,
          );
          if (!open.url) throw new Error("apps.connections.open returned no url");
          // stop() may have landed while that call was in flight. Opening now
          // would leave a live socket nobody holds a reference to.
          if (!this.socketRunning) return;
          socket = this.openSocket(open.url);
          connectedAt = Date.now();
          // Resolves on close, never rejects: a dropped socket is normal and
          // the loop's job is to reopen it, not to treat it as an error.
          await new Promise<void>((resolve) => {
            const ws = socket!;
            ws.onmessage = (ev: { data: unknown }) => {
              let env: SlackEnvelope;
              try {
                env = JSON.parse(String(ev.data)) as SlackEnvelope;
              } catch {
                // Validate at the boundary: log and drop, never half-handle.
                this.log(`unparseable socket frame dropped`);
                return;
              }
              // Ack first and always. Handling happens after, because a turn
              // outlives the deadline and Slack redelivers what it never saw
              // acknowledged.
              if (env.envelope_id) {
                try {
                  ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
                } catch (err) {
                  this.log(`ack failed: ${String(err)}`);
                }
              }
              if (env.type === "hello") return;
              if (env.type === "disconnect") {
                // Expected: Slack recycles connections. Closing resolves the
                // promise below and the loop reopens.
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
        // The anti-spin floor. A socket that lived a while was healthy, so the
        // next attempt starts from the floor again; one that died young — or
        // threw — backs off, because reopening instantly would hammer
        // apps.connections.open in a tight loop.
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
      // The reaction is already where we want it; that is a success.
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
    // An empty cursor means "no more"; Slack sends `""` rather than omitting it.
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
      limit: query.limit ?? 200,
      cursor: query.cursor,
    });
  }

  /**
   * Slack file URLs are private: they need the bot token as a bearer header and
   * answer HTML (a login page) rather than an error when it is missing.
   */
  async downloadFile(file: SlackFile): Promise<{ data: string; mimeType: string }> {
    const url = file.url_private_download ?? file.url_private;
    if (!url) throw new Error("slack file has no private url");
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`slack file download: ${res.status}`);
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? file.mimetype ?? "image/png";
    if (!mimeType.startsWith("image/")) throw new Error(`slack file is ${mimeType}, not an image`);
    return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
  }
}
