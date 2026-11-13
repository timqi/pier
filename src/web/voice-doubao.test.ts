import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, SocketCtor } from "./voice.js";
import { doubaoAsr } from "./voice-doubao.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../log.js", () => ({ logger: () => log }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Handler<K extends "onopen" | "onmessage" | "onerror" | "onclose"> = WebSocket[K];

/** A sent frame, decoded: header nibbles, then the payload. */
interface Sent { type: number; flags: number; serialization: number; compression: number; payload: Uint8Array }

/** Builds a server frame: 4-byte header, optional sequence, size, payload. */
function serverFrame(type: number, flags: number, payload: Uint8Array, opts: { gzip?: boolean; code?: number } = {}): ArrayBuffer {
  const body = opts.gzip ? new Uint8Array(gzipSync(payload)) : payload;
  const head = [0x11, (type << 4) | flags, 0x10 | (opts.gzip ? 1 : 0), 0];
  const extra = opts.code !== undefined || flags & 1 ? 4 : 0;
  const out = new Uint8Array(4 + extra + 4 + body.byteLength);
  out.set(head);
  const view = new DataView(out.buffer);
  if (opts.code !== undefined) view.setUint32(4, opts.code);
  else if (flags & 1) view.setInt32(4, 7);
  view.setUint32(4 + extra, body.byteLength);
  out.set(body, 8 + extra);
  return out.buffer;
}

const json = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const utterances = (...u: [string, boolean][]) => ({ result: { text: u.map(([t]) => t).join(""), utterances: u.map(([text, definite]) => ({ text, definite })) } });

/** The Volcengine end of the socket: what was sent, and the server's side to play. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Sent[] = [];
  closed = 0;
  binaryType: BinaryType = "blob";
  onopen: Handler<"onopen"> = null;
  onmessage: Handler<"onmessage"> = null;
  onerror: Handler<"onerror"> = null;
  onclose: Handler<"onclose"> = null;

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {
    FakeSocket.all.push(this);
  }
  send(sent: string | Blob | BufferSource): void {
    const data = sent as Uint8Array;
    const size = new DataView(data.buffer, data.byteOffset).getUint32(4);
    expect(data.byteLength).toBe(8 + size);
    this.sent.push({
      type: data[1]! >> 4, flags: data[1]! & 0x0f, serialization: data[2]! >> 4, compression: data[2]! & 0x0f,
      payload: data.slice(8),
    });
  }
  close(): void {
    this.closed++;
  }
  private get self(): WebSocket {
    return this as unknown as WebSocket;
  }
  open(): void {
    this.onopen?.call(this.self, new Event("open"));
  }
  server(data: ArrayBuffer | string): void {
    this.onmessage?.call(this.self, new MessageEvent("message", { data }));
  }
  respond(body: unknown, opts: { last?: boolean; gzip?: boolean } = {}): void {
    this.server(serverFrame(0b1001, opts.last ? 0b0011 : 0b0001, json(body), opts));
  }
  drop(code: number, reason = ""): void {
    this.onclose?.call(this.self, new CloseEvent("close", { code, reason }));
  }
  fail(): void {
    this.onerror?.call(this.self, new Event("error"));
  }
}

function start(readKey: () => string | undefined = () => "ak-test") {
  FakeSocket.all = [];
  const events: AsrEvent[] = [];
  const provider = doubaoAsr(readKey, FakeSocket satisfies SocketCtor);
  const stream = provider.open({}, (e) => events.push(e));
  const ws = FakeSocket.all[0]!;
  return { provider, stream, events, ws };
}

function ready() {
  const t = start();
  t.ws.open();
  return t;
}

describe("doubaoAsr", () => {
  it("is unavailable without a key, warning under its own name", () => {
    const provider = doubaoAsr(() => undefined, FakeSocket);
    expect(provider.available()).toBe(false);
    expect(provider.available()).toBe(false);
    expect(log.warn.mock.calls.map(([line]) => String(line))).toEqual(["DOUBAO_ASR_API_KEY is not in the vault — Doubao recognition is off"]);
    expect(doubaoAsr(() => "vt://abc", FakeSocket).available()).toBe(false);
    expect(log.warn.mock.calls.map(([line]) => String(line)).at(-1)).toBe(
      "DOUBAO_ASR_API_KEY is an approve-level vt:// record; voice input needs an auto row — Doubao recognition is off",
    );
    expect(doubaoAsr(() => "ak-test", FakeSocket).available()).toBe(true);
  });

  it("errors instead of connecting when the key went away", async () => {
    const t = start(() => undefined);
    expect(t.ws).toBeUndefined();
    await Promise.resolve();
    expect(t.events).toEqual([{ type: "error", message: "DOUBAO_ASR_API_KEY is not available" }]);
  });

  it("connects to model 2.0 with the key, sends the request on open and is ready", () => {
    const t = start();
    expect(t.ws.url).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
    expect(t.ws.init.headers).toEqual({
      "X-Api-Key": "ak-test", "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Request-Id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(t.ws.binaryType).toBe("arraybuffer");
    t.ws.open();
    expect(t.ws.sent).toHaveLength(1);
    const [request] = t.ws.sent;
    expect({ ...request, payload: undefined }).toEqual({ type: 0b0001, flags: 0, serialization: 1, compression: 0, payload: undefined });
    expect(JSON.parse(new TextDecoder().decode(request!.payload))).toEqual({
      audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_nonstream: true, show_utterances: true, result_type: "full" },
    });
    expect(t.events).toEqual([{ type: "ready" }]);
  });

  it("sends audio as raw frames of exactly the view's bytes, and an empty last frame on finish", () => {
    const t = ready();
    t.stream.audio(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4));
    t.stream.finish();
    expect(t.ws.sent.slice(1).map((s) => [s.type, s.flags, s.serialization, s.compression, [...s.payload]])).toEqual([
      [0b0010, 0, 0, 0, [1, 2, 3]],
      [0b0010, 0b0010, 0, 0, []],
    ]);
    t.stream.audio(new Uint8Array([1]));
    expect(t.ws.sent).toHaveLength(3);
  });

  it("maps the open utterances to partial, each definite one to final once, and the last package to done", () => {
    const t = ready();
    t.ws.respond({ audio_info: { duration: 0 } });
    t.ws.respond(utterances(["今天", false]));
    t.ws.respond(utterances(["今天天气", false]), { gzip: true });
    t.ws.respond(utterances(["今天天气不错。", true]));
    t.ws.respond(utterances(["今天天气不错。", true], ["阳光", false]));
    t.ws.respond(utterances(["今天天气不错。", true], ["阳光", false]));
    t.stream.finish();
    t.ws.respond(utterances(["今天天气不错。", true], ["阳光明媚。", false]), { last: true });
    t.ws.drop(1000);
    expect(t.events).toEqual([
      { type: "ready" },
      { type: "partial", text: "今天" },
      { type: "partial", text: "今天天气" },
      { type: "final", text: "今天天气不错。" },
      { type: "partial", text: "阳光" },
      { type: "final", text: "阳光明媚。" },
      { type: "done" },
    ]);
    expect(t.ws.closed).toBe(1);
  });

  it("keeps the partial through a response without utterances", () => {
    const t = ready();
    t.ws.respond(utterances(["今天", false]));
    t.ws.respond({ audio_info: { duration: 400 }, result: { text: "" } });
    t.ws.respond(utterances(["今天天气", false]));
    expect(t.events.slice(1)).toEqual([{ type: "partial", text: "今天" }, { type: "partial", text: "今天天气" }]);
  });

  it("clears the partial when its utterance settles empty", () => {
    const t = ready();
    t.ws.respond(utterances(["嗯", false]));
    t.ws.respond(utterances(["", true]));
    expect(t.events.slice(1)).toEqual([{ type: "partial", text: "嗯" }, { type: "partial", text: "" }]);
  });

  it("passes the server's error frame on as error", () => {
    const t = ready();
    t.ws.server(serverFrame(0b1111, 0, json({ error: "bad audio" }), { code: 45000151 }));
    t.ws.drop(1000);
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: 'Doubao error 45000151: {"error":"bad audio"}' }]);
    expect(t.ws.closed).toBe(1);
  });

  it("drops a frame that does not parse and keeps going", () => {
    const t = ready();
    t.ws.server("text");
    t.ws.server(new Uint8Array([0x11, 0x91, 0x10, 0, 0, 0, 0, 1, 0, 0, 0, 9, 1]).buffer);
    t.ws.server(serverFrame(0b0100, 0, json({})));
    t.ws.respond(utterances(["ok", true]));
    expect(t.events).toEqual([{ type: "ready" }, { type: "final", text: "ok" }]);
    expect(log.warn.mock.calls.map(([line]) => String(line))).toEqual([
      "Doubao sent a frame that does not parse (TypeError: not a binary frame) — dropped",
      "Doubao sent a frame that does not parse (RangeError: payload past the frame's end) — dropped",
      "Doubao sent a frame of an unknown message type — ignored",
    ]);
  });

  it("errors on a refused handshake with the server's reason, and on an unexpected close", async () => {
    const fetch = vi.fn(async () => new Response('{"error":"Invalid X-Api-Key"}', { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const refused = start();
    refused.ws.fail();
    refused.ws.drop(1006);
    await vi.waitFor(() => expect(refused.events).toEqual([{ type: "error", message: 'Doubao connection failed: HTTP 401 {"error":"Invalid X-Api-Key"}' }]));
    expect(fetch).toHaveBeenCalledWith("https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", expect.objectContaining({ headers: refused.ws.init.headers }));
    const t = ready();
    t.ws.drop(1011, "internal");
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: "Doubao closed the connection (1011 internal)" }]);
  });

  it("errors when the socket does not open within 8 s, or the take does not finish within 20 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = start();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(slow.events).toEqual([{ type: "error", message: "Doubao was not ready within 8 s" }]);
    slow.ws.open();
    expect(slow.ws.sent).toEqual([]);

    const t = ready();
    await vi.advanceTimersByTimeAsync(60_000);
    t.stream.finish();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: "Doubao did not finish within 20 s" }]);
  });

  it("closes quietly on close(), and emits nothing for the close that follows", () => {
    const t = ready();
    t.stream.close();
    t.ws.drop(1005);
    t.stream.close();
    expect(t.events).toEqual([{ type: "ready" }]);
    expect(t.ws.closed).toBe(1);
  });
});
