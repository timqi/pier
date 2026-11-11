// One voice take — microphone, capture worklet, the take's routes and event
// stream (03-web-workbench.md §Voice input) — released on every way out, and
// the pure rules for where its text sits in the draft. No DOM.

import workletUrl from "./voice-worklet.ts?worker&url";
import { failure, getJson, sendJson } from "./api.js";

/** The take's SSE events, as the server sends them. */
export type VoiceEvent =
  | { type: "ready" } | { type: "partial"; text: string } | { type: "final"; text: string }
  | { type: "error"; message: string } | { type: "done" };
export type TakeState = "starting" | "recording" | "finishing" | "idle";
export interface Take {
  /** No more audio: the last frame goes up, then `finish`; `done` ends it. */
  stop(): void;
  /** Drop the take now: no further event, `DELETE` to the server. */
  cancel(): void;
}

// 32 frames of 250 ms PCM16 at 16 kHz: under the server's 256 KB body cap.
const MAX_BODY = 32 * 8000;
// A context that never rendered never answers the flush.
const FLUSH_MS = 1000;
// A 404 or 409 says the take is over on the server; its event stream says why,
// and gets this long to, before the refusal itself is the reason.
const GONE_MS = 2000;

/** The server can transcribe and this browser can capture. */
export async function voiceAvailable(): Promise<boolean> {
  if (typeof AudioWorkletNode !== "function" || typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
  const got = await getJson<{ available: boolean }>("/api/voice", "voice input availability");
  if (!got.ok) console.warn(got.error);
  return got.ok && got.value.available;
}

const isEvent = (v: unknown): v is VoiceEvent => {
  const e = v as Partial<Record<"type" | "text" | "message", unknown>> | null;
  if (typeof e !== "object" || e === null) return false;
  if (e.type === "partial" || e.type === "final") return typeof e.text === "string";
  if (e.type === "error") return typeof e.message === "string";
  return e.type === "ready" || e.type === "done";
};

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "microphone access was denied";
  if (name === "NotFoundError") return "no microphone found";
  return `voice input failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** Called from the click: Safari starts an AudioContext only inside the gesture.
 *  `onState("idle")` comes last on every exit; `onEvent` carries `ready`,
 *  `partial`, `final`, then `done` or `error` — never after `cancel()`. */
export function startTake(on: { onEvent: (e: VoiceEvent) => void; onState: (s: TakeState) => void }): Take {
  const context = new AudioContext();
  let state: TakeState = "starting";
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let id: string | undefined;
  let events: EventSource | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let gone: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let captured = false; // the last frame is queued and the microphone released
  let released = false;
  let uploading = false;
  let finished = false;
  const queue: Uint8Array[] = [];

  // A function, not the comparison inline: TypeScript narrows `state` across awaits.
  const over = (): boolean => state === "idle";
  const set = (next: TakeState): void => {
    state = next;
    on.onState(next);
  };
  const release = (): void => {
    clearTimeout(flushTimer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    node?.disconnect();
    if (released) return;
    released = true;
    context.close().catch((err: unknown) => console.warn("voice: audio context did not close", err));
  };
  // The closed event stream cancels the take too, so a 404 is that having won.
  const remove = (take: string): void =>
    void fetch(`/api/voice/${take}`, { method: "DELETE" }).then(
      async (res) => {
        if (!res.ok && res.status !== 404) console.warn(await failure(res, "voice cancel failed"));
      },
      (err: unknown) => console.warn(`voice cancel failed: ${String(err)}`),
    );
  /** `server`: the stream ended it, so there is nothing to delete. */
  const end = (event?: VoiceEvent, server = false): void => {
    if (over()) return;
    clearTimeout(gone);
    events?.close();
    release();
    if (!server && id) remove(id);
    if (event) on.onEvent(event);
    set("idle");
  };
  const fail = (message: string): void => end({ type: "error", message });

  /** True when the server took it. */
  const post = async (path: "audio" | "finish", label: string, body?: Uint8Array<ArrayBuffer>): Promise<boolean> => {
    try {
      const res = await fetch(`/api/voice/${id}/${path}`, { method: "POST", ...(body && { headers: { "content-type": "application/octet-stream" }, body }) });
      if (res.ok) return true;
      const why = await failure(res, label);
      if (res.status === 404 || res.status === 409) gone ??= setTimeout(() => fail(why), GONE_MS);
      else fail(why);
    } catch (err) {
      fail(`${label}: ${String(err)}`);
    }
    return false;
  };
  // Serial: one POST in flight, the frames that queue meanwhile go up as one body.
  const pump = async (): Promise<void> => {
    if (uploading || gone || !id || over()) return;
    if (!queue.length) {
      if (captured && !finished) {
        finished = true;
        await post("finish", "voice finish failed");
      }
      return;
    }
    let size = 0;
    let count = 0;
    while (count < queue.length && (count === 0 || size + queue[count]!.length <= MAX_BODY)) size += queue[count++]!.length;
    const body = new Uint8Array(size);
    let at = 0;
    for (const frame of queue.splice(0, count)) {
      body.set(frame, at);
      at += frame.length;
    }
    uploading = true;
    const up = await post("audio", "voice upload failed", body);
    uploading = false;
    if (up) return pump();
  };
  const flushed = (): void => {
    if (captured) return;
    captured = true;
    release();
    void pump();
  };
  const flush = (): void => {
    node!.port.postMessage("flush");
    flushTimer = setTimeout(flushed, FLUSH_MS);
  };
  const receive = (data: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      event = undefined;
    }
    if (!isEvent(event)) return console.warn("voice: dropped a malformed event", data);
    if (event.type === "done" || event.type === "error") return end(event, true);
    if (event.type === "ready" && state === "starting") set("recording");
    if (!over()) on.onEvent(event);
  };

  set("starting");
  void (async () => {
    const mic = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then((media) => {
        stream = media;
        // Ended while the permission was being asked: the take never gets it.
        if (over()) release();
      });
    try {
      await Promise.all([mic, context.audioWorklet.addModule(workletUrl)]);
    } catch (err) {
      return fail(micError(err));
    }
    if (over()) return;
    let res: Response;
    try {
      res = await sendJson("/api/voice", {});
      if (!res.ok) return fail(await failure(res, "voice input is unavailable"));
      id = ((await res.json()) as { id: string }).id;
    } catch (err) {
      return fail(`voice input failed: ${String(err)}`);
    }
    // Cancelled while the take was being opened: it has no events to close yet.
    if (over()) return remove(id);
    events = new EventSource(`/api/voice/${id}/events`);
    events.onmessage = (ev: MessageEvent<string>) => receive(ev.data);
    // EventSource would reconnect, but a closed stream has already cancelled the take.
    events.onerror = () => fail("voice connection lost");
    try {
      node = new AudioWorkletNode(context, "pier-voice");
      node.port.onmessage = (ev: MessageEvent<ArrayBuffer | "flushed">) => {
        if (ev.data === "flushed") return flushed();
        queue.push(new Uint8Array(ev.data));
        void pump();
      };
      // Into the destination as silence: a node nothing pulls may never render.
      context.createMediaStreamSource(stream!).connect(node).connect(context.destination);
    } catch (err) {
      return fail(micError(err));
    }
    if (stopping) flush();
  })();

  return {
    stop() {
      if (state === "idle" || stopping) return;
      stopping = true;
      set("finishing");
      if (node) flush();
    },
    cancel: () => end(),
  };
}

// --- the take's text in the draft --------------------------------------------------
// The span is the take's text in the draft: [start, mid) its final sentences,
// [mid, end) the current partial. Each rule says which range of the draft to
// replace with what, and the span after it (null: the take no longer owns any).

export interface Span { start: number; mid: number; end: number }
export interface SpanEdit { from: number; to: number; text: string; span: Span | null }

export const spanAt = (caret: number): Span => ({ start: caret, mid: caret, end: caret });

// A letter or digit of a script that puts spaces between its words.
const SPACED = /^(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{N}]/u;

/** `partial` replaces the tail; `final` turns it into settled text. `prev` is
 *  the draft's character before the tail: a recognizer sends its sentences
 *  bare, and a spaced script after a word or its punctuation needs the space. */
export function spanText(span: Span, event: "partial" | "final", text: string, prev = ""): SpanEdit {
  if ((SPACED.test(prev) || /[.,!?;:]/.test(prev)) && SPACED.test(text)) text = ` ${text}`;
  const end = span.mid + text.length;
  return { from: span.mid, to: span.end, text, span: { start: span.start, mid: event === "final" ? end : span.mid, end } };
}

/** An error keeps the final sentences and drops the partial. */
export const spanError = (span: Span): SpanEdit => ({ from: span.mid, to: span.end, text: "", span: null });

/** A cancel removes what the take still owns. */
export const spanCancel = (span: Span): SpanEdit => ({ from: span.start, to: span.end, text: "", span: null });

/** Where a caret at `p` is after the edit: at or past the replaced text it
 *  moves with it, so one at the take's end stays at its end; inside, it stops
 *  at the new text's end. `setRangeText`'s "preserve" leaves the first behind. */
export function caretAfter(e: SpanEdit, p: number): number {
  const end = e.from + e.text.length;
  return p >= e.to ? p + end - e.to : Math.min(p, end);
}

/** The span after the user turned `before` into `after`, the caret at `caret`:
 *  moved by an edit wholly before it, kept by one after it, and given up — its
 *  text the user's — by one that touches it, a new one starting at the caret. */
export function spanEdited(span: Span, before: string, after: string, caret: number): Span {
  const delta = after.length - before.length;
  // Typing, deleting and replacing a selection leave the caret at the edit's end.
  let end = caret - delta;
  if (end < 0 || end > before.length || before.slice(end) !== after.slice(caret)) {
    let suffix = 0;
    while (suffix < Math.min(before.length, after.length) && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    end = before.length - suffix;
  }
  let prefix = 0;
  while (prefix < end && before[prefix] === after[prefix]) prefix++;
  if (end <= span.start) return { start: span.start + delta, mid: span.mid + delta, end: span.end + delta };
  if (prefix >= span.end) return span;
  return spanAt(caret);
}
