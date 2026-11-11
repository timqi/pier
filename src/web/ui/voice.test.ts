// The take's lifecycle over fake audio, fetch and EventSource; the draft span's rules as pure edits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caretAfter, type Span, type SpanEdit, spanAt, voiceAvailable, spanCancel, spanEdited, spanError, spanText, startTake, type TakeState, type VoiceEvent } from "./voice.js";

vi.mock("./voice-worklet.ts?worker&url", () => ({ default: "/app/assets/voice-worklet.js" }));

const apply = (text: string, e: SpanEdit): string => text.slice(0, e.from) + e.text + text.slice(e.to);

describe("draft span", () => {
  /** Run the edits in order from `text`, the span starting at `caret`. */
  const run = (text: string, caret: number, ...steps: ((s: Span) => SpanEdit)[]) => {
    let span: Span | null = spanAt(caret);
    for (const step of steps) {
      const e = step(span!);
      text = apply(text, e);
      span = e.span;
    }
    return { text, span };
  };

  it("replaces the partial whole and appends each final at the caret", () => {
    const partial = (t: string) => (s: Span) => spanText(s, "partial", t);
    const final = (t: string) => (s: Span) => spanText(s, "final", t);
    expect(run("ab|cd", 3, partial("he"), partial("hello")).text).toBe("ab|hellocd");
    const { text, span } = run("ab|cd", 3, partial("hel"), final("Hello."), partial("wor"), final("World."), partial("ag"));
    expect(text).toBe("ab|Hello.World.agcd");
    expect(span).toEqual({ start: 3, mid: 15, end: 17 });
  });

  it("puts the space a bare sentence lacks between spaced scripts, and none beside CJK or a space", () => {
    expect(spanText(spanAt(4), "final", "Été.", "é").text).toBe(" Été.");
    expect(spanText(spanAt(4), "final", "Привет", "!").text).toBe(" Привет");
    expect(spanText(spanAt(6), "final", "How are you?", ".").text).toBe(" How are you?");
    expect(spanText(spanAt(5), "partial", "wor", "o")).toEqual({ from: 5, to: 5, text: " wor", span: { start: 5, mid: 5, end: 9 } });
    for (const [prev, text] of [[" ", "next"], ["\n", "next"], ["。", "next"], [".", "你好"], ["か", "next"], [".", " spaced"], ["a", ", then"], [undefined, "first"]] as const)
      expect(spanText(spanAt(3), "final", text, prev).text).toBe(text);
  });

  it("carries a caret at or past the replaced text, the take's end included, and leaves one before it", () => {
    const grow = spanText({ start: 4, mid: 7, end: 9 }, "partial", "three"); // [7, 9) → 5 chars
    expect([2, 7, 8, 9, 12].map((p) => caretAfter(grow, p))).toEqual([2, 7, 8, 12, 15]);
    const cancel = spanCancel({ start: 4, mid: 7, end: 9 });
    expect([2, 6, 9, 12].map((p) => caretAfter(cancel, p))).toEqual([2, 4, 4, 7]);
  });

  it("drops the partial on an error and everything it owns on a cancel", () => {
    const owned = run("x", 1, (s) => spanText(s, "final", "One."), (s) => spanText(s, "partial", "tw"));
    expect(apply(owned.text, spanError(owned.span!))).toBe("xOne.");
    expect(spanError(owned.span!).span).toBeNull();
    expect(apply(owned.text, spanCancel(owned.span!))).toBe("x");
  });

  const span = { start: 4, mid: 7, end: 9 }; // "pre one tw post": "one" settled, "tw" partial
  const draft = "pre onetw post";

  it("moves with an edit wholly before it, even one ending at its start", () => {
    expect(spanEdited(span, draft, "Xpre onetw post", 1)).toEqual({ start: 5, mid: 8, end: 10 });
    expect(spanEdited(span, draft, "preonetw post", 3)).toEqual({ start: 3, mid: 6, end: 8 });
    expect(spanEdited(span, draft, "pre !onetw post", 5)).toEqual({ start: 5, mid: 8, end: 10 });
  });

  it("reads the caret, not the first difference, when the typed letter repeats the span's", () => {
    // "o" typed just before "one": a plain prefix diff would place it inside the span.
    expect(spanEdited(span, draft, "pre oonetw post", 5)).toEqual({ start: 5, mid: 8, end: 10 });
  });

  it("stays put for an edit after it", () => {
    expect(spanEdited(span, draft, "pre onetw post!", 15)).toBe(span);
    expect(spanEdited(span, draft, "pre onetw!post", 10)).toBe(span);
  });

  it("is given up to the user by an edit touching it, and restarts empty at the caret", () => {
    const next = spanEdited(span, draft, "pre onXetw post", 7);
    expect(next).toEqual({ start: 7, mid: 7, end: 7 });
    // A cancel now removes nothing the user took over.
    expect(apply("pre onXetw post", spanCancel(next))).toBe("pre onXetw post");
  });

  it("falls back to the text when the caret does not close the edit", () => {
    // A select-all replace with the caret left at 0.
    expect(spanEdited(span, draft, "new", 0)).toEqual(spanAt(0));
    expect(spanEdited(span, draft, "Zpre onetw post", 0)).toEqual({ start: 5, mid: 8, end: 10 });
  });
});

// --- the take ------------------------------------------------------------------------

interface Res { ok: boolean; status: number; json: () => Promise<unknown> }
const res = (status: number, body: unknown = {}): Res => ({ ok: status < 300, status, json: () => Promise.resolve(body) });
const deferred = () => {
  let resolve!: (r: Res) => void;
  const promise = new Promise<Res>((r) => { resolve = r; });
  return { promise, resolve };
};
const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

let calls: { url: string; method: string; body?: Uint8Array }[];
let audio: ReturnType<typeof deferred>[];
let opened: ReturnType<typeof deferred> | null;
let available: boolean;
let sources: { url: string; onmessage: ((ev: { data: string }) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> }[];
let nodes: { port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((ev: { data: unknown }) => void) | null }; disconnect: ReturnType<typeof vi.fn> }[];
let contexts: { close: ReturnType<typeof vi.fn> }[];
let track: { stop: ReturnType<typeof vi.fn> };
let mic: Promise<unknown>;
let states: TakeState[];
let events: VoiceEvent[];

beforeEach(() => {
  calls = []; audio = []; opened = null; sources = []; nodes = []; contexts = []; states = []; events = [];
  track = { stop: vi.fn() };
  mic = Promise.resolve({ getTracks: () => [track] });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body instanceof Uint8Array ? init.body : undefined });
    if (url === "/api/voice" && method === "GET") return Promise.resolve(res(200, { available }));
    if (url === "/api/voice" && method === "POST") return opened ? opened.promise : Promise.resolve(res(200, { id: "t1" }));
    if (url.endsWith("/audio")) {
      const d = deferred();
      audio.push(d);
      return d.promise;
    }
    return Promise.resolve(res(202));
  }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => mic } });
  vi.stubGlobal("AudioContext", class {
    audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
    destination = {};
    close = vi.fn(() => Promise.resolve());
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect: (n: unknown) => n }; }
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { postMessage: vi.fn(), onmessage: null };
    disconnect = vi.fn();
    constructor() { nodes.push(this); }
    connect(n: unknown) { return n; }
  });
  vi.stubGlobal("EventSource", class {
    onmessage = null;
    onerror = null;
    close = vi.fn();
    constructor(readonly url: string) { sources.push(this); }
  });
});
afterEach(() => vi.unstubAllGlobals());

const start = () => startTake({ onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
const send = (event: unknown) => sources[0]!.onmessage!({ data: JSON.stringify(event) });
/** A 250 ms frame from the worklet, every byte `fill`. */
const frame = (fill: number, bytes = 8000) => nodes[0]!.port.onmessage!({ data: new Uint8Array(bytes).fill(fill).buffer });
const uploads = () => calls.filter((c) => c.url.endsWith("/audio"));
const released = () => track.stop.mock.calls.length > 0 && contexts[0]!.close.mock.calls.length === 1;

describe("a take", () => {
  it("runs ready → partial → final, uploads, finishes after the last frame, and ends on done", async () => {
    const take = start();
    await settled();
    expect(calls[0]).toMatchObject({ url: "/api/voice", method: "POST" });
    expect(sources[0]!.url).toBe("/api/voice/t1/events");
    send({ type: "ready" });
    send({ type: "partial", text: "hel" });
    send({ type: "final", text: "Hello." });
    expect(events).toEqual([{ type: "ready" }, { type: "partial", text: "hel" }, { type: "final", text: "Hello." }]);
    frame(1);
    expect(uploads()).toHaveLength(1);
    audio[0]!.resolve(res(202));
    await settled();
    take.stop();
    expect(nodes[0]!.port.postMessage).toHaveBeenCalledWith("flush");
    frame(2, 100);
    nodes[0]!.port.onmessage!({ data: "flushed" });
    expect(released()).toBe(true);
    expect(uploads()[1]!.body).toEqual(new Uint8Array(100).fill(2));
    expect(calls.some((c) => c.url.endsWith("/finish"))).toBe(false); // not before the last frame is up
    audio[1]!.resolve(res(202));
    await settled();
    expect(calls.filter((c) => c.url.endsWith("/finish"))).toEqual([{ url: "/api/voice/t1/finish", method: "POST", body: undefined }]);
    send({ type: "partial", text: "late" });
    send({ type: "done" });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(states).toEqual(["starting", "recording", "finishing", "idle"]);
    expect(sources[0]!.close).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps one upload in flight and sends what queued meanwhile as one body, in order, under the cap", async () => {
    start();
    await settled();
    frame(1);
    for (let i = 2; i <= 41; i++) frame(i);
    expect(uploads()).toHaveLength(1);
    audio[0]!.resolve(res(202));
    await settled();
    expect(uploads()).toHaveLength(2);
    const second = uploads()[1]!.body!;
    expect(second.length).toBe(32 * 8000);
    expect([second[0], second[8000], second.at(-1)]).toEqual([2, 3, 33]);
    audio[1]!.resolve(res(202));
    await settled();
    const third = uploads()[2]!.body!;
    expect([third.length, third[0], third.at(-1)]).toEqual([8 * 8000, 34, 41]);
  });

  it("ends on the server's error, keeping the message and deleting nothing", async () => {
    start();
    await settled();
    send({ type: "error", message: "upstream closed" });
    expect(events).toEqual([{ type: "error", message: "upstream closed" }]);
    expect(states.at(-1)).toBe("idle");
    expect(released()).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("turns a refused upload into an error and deletes the take", async () => {
    start();
    await settled();
    frame(1);
    audio[0]!.resolve(res(413, { error: "audio body too large" }));
    await settled();
    expect(events).toEqual([{ type: "error", message: "audio body too large" }]);
    expect(calls.at(-1)).toMatchObject({ url: "/api/voice/t1", method: "DELETE" });
    expect(released()).toBe(true);
  });

  it("leaves a take the server says is over to its event stream's reason, and stops uploading", async () => {
    start();
    await settled();
    frame(1);
    frame(2);
    audio[0]!.resolve(res(409, { error: "this voice take has ended" }));
    await settled();
    frame(3);
    expect(events).toEqual([]);
    expect(uploads()).toHaveLength(1);
    send({ type: "error", message: "another voice take started in this browser" });
    expect(events).toEqual([{ type: "error", message: "another voice take started in this browser" }]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("fails with the refusal itself when the stream never gives the reason", async () => {
    vi.useFakeTimers();
    try {
      start();
      await settled();
      frame(1);
      audio[0]!.resolve(res(404, { error: "no such voice take" }));
      await settled();
      vi.advanceTimersByTime(1999);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(events).toEqual([{ type: "error", message: "no such voice take" }]);
      expect(released()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends with an error, the microphone released, when the capture graph cannot be built", async () => {
    vi.stubGlobal("AudioWorkletNode", class { constructor() { throw new Error("no such processor"); } });
    start();
    await settled();
    expect(events).toEqual([{ type: "error", message: "voice input failed: no such processor" }]);
    expect(states.at(-1)).toBe("idle");
    expect(released()).toBe(true);
  });

  it("treats a lost event stream as an error", async () => {
    start();
    await settled();
    sources[0]!.onerror!();
    expect(events).toEqual([{ type: "error", message: "voice connection lost" }]);
  });

  it("drops a malformed event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    start();
    await settled();
    sources[0]!.onmessage!({ data: "{nope" });
    send({ type: "partial" });
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("cancels silently: no event after it, the take deleted, everything released", async () => {
    const take = start();
    await settled();
    send({ type: "ready" });
    take.cancel();
    send({ type: "final", text: "too late" });
    expect(events).toEqual([{ type: "ready" }]);
    expect(states).toEqual(["starting", "recording", "idle"]);
    expect(calls.at(-1)).toMatchObject({ url: "/api/voice/t1", method: "DELETE" });
    expect(sources[0]!.close).toHaveBeenCalled();
    expect(released()).toBe(true);
  });

  it("takes a 404 for the delete as the closed stream having cancelled first, and warns of any other refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockClear().mockImplementation(() => {});
    const refuse = (status: number) => vi.mocked(fetch).mockImplementation(((url: string, init: RequestInit = {}) =>
      Promise.resolve(init.method === "DELETE" ? res(status, { error: "refused" }) : res(200, { id: "t1" }))) as unknown as typeof fetch);
    refuse(404);
    start();
    await settled();
    sources[0]!.onerror!();
    await settled();
    expect(warn).not.toHaveBeenCalled();
    refuse(500);
    start();
    await settled();
    sources[1]!.onerror!();
    await settled();
    expect(warn).toHaveBeenCalledWith("refused");
  });

  it("says the microphone was refused and never opens a take", async () => {
    mic = Promise.reject(new DOMException("denied", "NotAllowedError"));
    start();
    await settled();
    expect(events).toEqual([{ type: "error", message: "microphone access was denied" }]);
    expect(calls).toEqual([]);
    expect(contexts[0]!.close).toHaveBeenCalled();
  });

  it("releases a microphone granted after a cancel, and deletes a take opened after one", async () => {
    let grant!: (s: unknown) => void;
    mic = new Promise((r) => { grant = r; });
    start().cancel();
    grant({ getTracks: () => [track] });
    await settled();
    expect(track.stop).toHaveBeenCalled();
    expect(calls).toEqual([]);

    mic = Promise.resolve({ getTracks: () => [track] });
    opened = deferred();
    const take = start();
    await settled();
    take.cancel();
    opened.resolve(res(200, { id: "t2" }));
    await settled();
    expect(calls.at(-1)).toMatchObject({ url: "/api/voice/t2", method: "DELETE" });
    expect(sources).toEqual([]);
  });

  it("finishes once set up when stopped while starting", async () => {
    const take = start();
    take.stop();
    expect(states).toEqual(["starting", "finishing"]);
    await settled();
    expect(nodes[0]!.port.postMessage).toHaveBeenCalledWith("flush");
    send({ type: "ready" });
    expect(states).toEqual(["starting", "finishing"]); // ready does not reopen a stopping take
  });
});

describe("availability", () => {
  it("asks the server only where the browser can capture", async () => {
    available = false;
    expect(await voiceAvailable()).toBe(false);
    expect(calls).toEqual([{ url: "/api/voice", method: "GET", body: undefined }]);
    available = true;
    expect(await voiceAvailable()).toBe(true);
    vi.stubGlobal("AudioWorkletNode", undefined);
    expect(await voiceAvailable()).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
