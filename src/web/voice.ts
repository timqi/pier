// Voice input's relay (/api/voice*): one recognition take per browser, its
// audio in over POST and its text out over SSE, to a swappable AsrProvider.
// See docs/plans/37-voice-input.md for the wire contract.

import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readCapped } from "../core/inbox.js";
import { logger } from "../log.js";
import { sessionIdOf } from "./auth.js";

const log = logger("voice");

export type AsrEvent =
  | { type: "ready" } | { type: "partial"; text: string } | { type: "final"; text: string }
  | { type: "error"; message: string } | { type: "done" };
/** `audio` and `finish` come only after the provider emitted `ready`; `close`
 *  is idempotent and emits nothing. */
export interface AsrStream { audio(pcm: Uint8Array): void; finish(): void; close(): void }
export interface AsrProvider {
  /** false = 按钮不显示；同步、便宜（读一次 vault）。 */
  available(): boolean;
  open(opts: { language?: string }, emit: (e: AsrEvent) => void): AsrStream;
}

const MAX_AUDIO_BYTES = 256 * 1024;
const MAX_TAKE_MS = 5 * 60_000;
const IDLE_MS = 15_000;
/** Audio posted before the provider is ready waits here, this many bodies at most. */
const MAX_PENDING = 128;
const HEARTBEAT_MS = 15_000;
const NOT_FOUND = "no such voice take";

interface Take {
  id: string;
  /** The browser session (`sessionIdOf`) that opened it; nobody else may touch it. */
  owner: string;
  started: number;
  stream?: AsrStream;
  ready: boolean;
  finishing: boolean;
  finishSent: boolean;
  ended: boolean;
  pending: Uint8Array[];
  /** Events emitted before the SSE attached, or after it never did. */
  backlog: AsrEvent[];
  attached: boolean;
  listener?: (e: AsrEvent) => void;
  onEnd?: () => void;
  idle?: NodeJS.Timeout;
  cap?: NodeJS.Timeout;
}

/** Scripted recognition: each body advances the script by its byte count,
 *  deterministic and timer-free, for tests and keyless manual runs. Sentences
 *  come bare, as a recognizer sends them. */
export const MOCK_SCRIPT = ["Pier heard you.", "This is the mock recognizer."];
const MOCK_BYTES_PER_CHAR = 3_200; // 100 ms of 16 kHz PCM16

export const mockAsr: AsrProvider = {
  available: () => true,
  open(_opts, emit) {
    let bytes = 0;
    let sentence = 0;
    let closed = false;
    queueMicrotask(() => {
      if (!closed) emit({ type: "ready" });
    });
    const heard = (): string => {
      let chars = Math.floor(bytes / MOCK_BYTES_PER_CHAR);
      for (let i = 0; i < sentence; i++) chars -= MOCK_SCRIPT[i]?.length ?? 0;
      return (MOCK_SCRIPT[sentence] ?? "").slice(0, chars);
    };
    return {
      audio(pcm) {
        if (closed) return;
        bytes += pcm.byteLength;
        for (let text = heard(); sentence < MOCK_SCRIPT.length; text = heard()) {
          if (text !== MOCK_SCRIPT[sentence]) {
            if (text) emit({ type: "partial", text });
            return;
          }
          emit({ type: "final", text });
          sentence++;
        }
      },
      finish() {
        if (closed) return;
        closed = true;
        const rest = heard();
        if (rest) emit({ type: "final", text: rest });
        emit({ type: "done" });
      },
      close() {
        closed = true;
      },
    };
  },
};

export function registerVoiceRoutes(app: Hono, provider: AsrProvider | undefined): void {
  const takes = new Map<string, Take>();

  const own = (c: Context): Take | undefined => {
    const take = takes.get(c.req.param("id") ?? "");
    return take?.owner === sessionIdOf(c) ? take : undefined;
  };

  const deliver = (take: Take, e: AsrEvent): void => {
    if (take.listener) return take.listener(e);
    // A partial replaces the sentence's previous one, so an unread backlog stays sentence-sized.
    if (e.type === "partial" && take.backlog.at(-1)?.type === "partial") take.backlog.pop();
    take.backlog.push(e);
  };

  /** Audio and text never reach the log: only the take, its length and why it ended. */
  const end = (take: Take, reason: string, event?: AsrEvent): void => {
    if (take.ended) return;
    take.ended = true;
    clearTimeout(take.idle);
    clearTimeout(take.cap);
    if (event) deliver(take, event);
    take.stream?.close();
    // An unread ending waits for its SSE, so the failure still reaches the browser.
    if (take.listener || !event) takes.delete(take.id);
    else take.idle = setTimeout(() => takes.delete(take.id), IDLE_MS);
    take.onEnd?.();
    const seconds = ((Date.now() - take.started) / 1000).toFixed(1);
    log.info(`take ${take.id.slice(0, 8)} ended after ${seconds} s — ${reason}`);
  };
  const fail = (take: Take, reason: string, message: string): void => end(take, reason, { type: "error", message });

  const armIdle = (take: Take): void => {
    clearTimeout(take.idle);
    take.idle = setTimeout(() => fail(take, "idle", `no audio for ${IDLE_MS / 1000} s`), IDLE_MS);
  };

  const flush = (take: Take): void => {
    if (!take.ready || !take.stream || take.ended) return;
    for (const pcm of take.pending.splice(0)) take.stream.audio(pcm);
    if (take.finishing && !take.finishSent) {
      take.finishSent = true;
      take.stream.finish();
    }
  };

  const onEvent = (take: Take, e: AsrEvent): void => {
    if (take.ended) return;
    if (e.type === "error") return fail(take, `upstream error: ${e.message}`, e.message);
    if (e.type === "done") return end(take, "done", e);
    if (e.type === "ready") {
      if (take.ready) return;
      take.ready = true;
      deliver(take, e);
      return flush(take);
    }
    deliver(take, e);
  };

  app.get("/api/voice", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ available: provider?.available() ?? false });
  });

  app.post("/api/voice", async (c) => {
    if (!provider?.available()) return c.json({ error: "voice input is not configured" }, 503);
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const language = (body as { language?: unknown } | null)?.language;
    if (language !== undefined && (typeof language !== "string" || !/^[A-Za-z-]{1,16}$/.test(language))) {
      return c.json({ error: "language must be a language code" }, 400);
    }
    const owner = sessionIdOf(c);
    for (const old of takes.values()) {
      if (old.owner === owner && !old.ended) fail(old, "replaced", "another voice take started in this browser");
    }
    const take: Take = {
      id: randomUUID(), owner, started: Date.now(), ready: false, finishing: false, finishSent: false,
      ended: false, pending: [], backlog: [], attached: false,
    };
    takes.set(take.id, take);
    take.cap = setTimeout(() => fail(take, "limit", `a voice take is limited to ${MAX_TAKE_MS / 60_000} minutes`), MAX_TAKE_MS);
    armIdle(take);
    log.info(`take ${take.id.slice(0, 8)} opened`);
    try {
      take.stream = provider.open(language === undefined ? {} : { language }, (e) => onEvent(take, e));
    } catch (err) {
      fail(take, "open failed", `voice input could not start: ${String(err)}`);
    }
    // The provider may have answered during open, before the stream existed.
    if (take.ended) take.stream?.close();
    else flush(take);
    return c.json({ id: take.id });
  });

  app.get("/api/voice/:id/events", (c) => {
    const take = own(c);
    if (!take) return c.json({ error: NOT_FOUND }, 404);
    if (take.attached) return c.json({ error: "this voice take is already streaming" }, 409);
    take.attached = true;
    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const write = (frame: string): void => {
        writes = writes
          .then(() => stream.write(frame))
          .then(() => undefined, (err: unknown) => log.warn(`take ${take.id.slice(0, 8)} event write failed: ${String(err)}`));
      };
      let resolve!: () => void;
      const closed = new Promise<void>((r) => (resolve = r));
      take.onEnd = resolve;
      const listener = (e: AsrEvent): void => write(`data: ${JSON.stringify(e)}\n\n`);
      take.listener = listener;
      for (const e of take.backlog.splice(0)) listener(e);
      if (take.ended) {
        clearTimeout(take.idle);
        takes.delete(take.id);
        resolve();
      }
      stream.onAbort(() => end(take, "cancelled: the event stream closed"));
      const ping = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      await closed;
      clearInterval(ping);
      await writes;
    });
  });

  app.post("/api/voice/:id/audio", async (c) => {
    const take = own(c);
    if (!take) return c.json({ error: NOT_FOUND }, 404);
    let pcm: Uint8Array;
    try {
      pcm = await readCapped(c.req.raw.body, MAX_AUDIO_BYTES);
    } catch {
      return c.json({ error: `an audio body is limited to ${MAX_AUDIO_BYTES / 1024} KB` }, 413);
    }
    if (take.ended) return c.json({ error: "this voice take has ended" }, 409);
    if (take.finishing) return c.json({ error: "this voice take is finishing" }, 409);
    armIdle(take);
    if (!pcm.byteLength) return c.body(null, 202);
    if (take.ready && take.stream) {
      take.stream.audio(pcm);
    } else if (take.pending.length < MAX_PENDING) {
      take.pending.push(pcm);
    } else {
      const message = "the recognizer did not become ready before the audio buffer filled";
      fail(take, "buffer full", message);
      return c.json({ error: message }, 409);
    }
    return c.body(null, 202);
  });

  app.post("/api/voice/:id/finish", (c) => {
    const take = own(c);
    if (!take) return c.json({ error: NOT_FOUND }, 404);
    if (take.ended) return c.json({ error: "this voice take has ended" }, 409);
    // From here the provider's own finish timeout bounds the wait, not the idle one.
    clearTimeout(take.idle);
    take.finishing = true;
    flush(take);
    return c.body(null, 202);
  });

  app.delete("/api/voice/:id", (c) => {
    const take = own(c);
    if (!take) return c.json({ error: NOT_FOUND }, 404);
    if (take.ended) {
      clearTimeout(take.idle);
      takes.delete(take.id);
    } else {
      end(take, "cancelled");
    }
    return c.body(null, 204);
  });
}
