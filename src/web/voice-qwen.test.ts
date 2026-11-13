import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, SocketCtor } from "./voice.js";
import { qwenAsr } from "./voice-qwen.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../log.js", () => ({ logger: () => log }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Handler<K extends "onopen" | "onmessage" | "onerror" | "onclose"> = WebSocket[K];

/** The DashScope end of the socket: what was sent, and the server's side to play. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Record<string, unknown>[] = [];
  closed = 0;
  binaryType: BinaryType = "blob";
  onopen: Handler<"onopen"> = null;
  onmessage: Handler<"onmessage"> = null;
  onerror: Handler<"onerror"> = null;
  onclose: Handler<"onclose"> = null;

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
  server(event: Record<string, unknown> | string): void {
    const data = typeof event === "string" ? event : JSON.stringify(event);
    this.onmessage?.call(this.self, new MessageEvent("message", { data }));
  }
  drop(code: number, reason = ""): void {
    this.onclose?.call(this.self, new CloseEvent("close", { code, reason }));
  }
  fail(): void {
    this.onerror?.call(this.self, new Event("error"));
  }
}

function start(language?: string, readKey: () => string | undefined = () => "sk-test") {
  FakeSocket.all = [];
  const events: AsrEvent[] = [];
  const provider = qwenAsr(readKey, FakeSocket satisfies SocketCtor);
  const stream = provider.open(language ? { language } : {}, (e) => events.push(e));
  const ws = FakeSocket.all[0]!;
  return { provider, stream, events, ws };
}

/** Connected and acknowledged: the state the route sends audio in. */
function ready(language?: string) {
  const t = start(language);
  t.ws.open();
  t.ws.server({ type: "session.updated", session: {} });
  return t;
}

describe("qwenAsr", () => {
  it("is unavailable without a key, behind a locked vault, or with a vt:// record, warning once per state", () => {
    let key: () => string | undefined = () => undefined;
    const provider = qwenAsr(() => key(), FakeSocket);
    expect(provider.available()).toBe(false);
    expect(provider.available()).toBe(false);
    key = () => {
      throw new Error("secrets locked: unlock() has not run");
    };
    expect(provider.available()).toBe(false);
    key = () => "vt://abc";
    expect(provider.available()).toBe(false);
    expect(log.warn.mock.calls.map(([line]) => String(line))).toEqual([
      "DASHSCOPE_API_KEY is not in the vault — DashScope recognition is off",
      "DASHSCOPE_API_KEY cannot be read: secrets locked: unlock() has not run — DashScope recognition is off",
      "DASHSCOPE_API_KEY is an approve-level vt:// record; voice input needs an auto row — DashScope recognition is off",
    ]);
    key = () => "sk-test";
    expect(provider.available()).toBe(true);
  });

  it("errors instead of connecting when the key went away", async () => {
    const t = start(undefined, () => undefined);
    expect(t.ws).toBeUndefined();
    await Promise.resolve();
    expect(t.events).toEqual([{ type: "error", message: "DASHSCOPE_API_KEY is not available" }]);
  });

  it("connects with the key, configures the session on open and is ready on session.updated", () => {
    const t = start("zh");
    expect(t.ws.url).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime");
    expect(t.ws.init.headers).toEqual({ Authorization: "Bearer sk-test", "OpenAI-Beta": "realtime=v1" });
    t.ws.open();
    expect(t.ws.sent).toEqual([{
      event_id: "event_1",
      type: "session.update",
      session: {
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: { language: "zh" },
        turn_detection: { type: "server_vad", threshold: 0, silence_duration_ms: 400 },
      },
    }]);
    t.ws.server({ type: "session.created", session: {} });
    expect(t.events).toEqual([]);
    t.ws.server({ type: "session.updated", session: {} });
    expect(t.events).toEqual([{ type: "ready" }]);
  });

  it("leaves the language to the model when none is given", () => {
    const t = start();
    t.ws.open();
    expect((t.ws.sent[0]!.session as Record<string, unknown>).input_audio_transcription).toBeUndefined();
  });

  it("appends audio as base64 of exactly the view's bytes", () => {
    const t = ready();
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    t.stream.audio(backing.subarray(1, 4));
    expect(t.ws.sent.at(-1)).toEqual({ event_id: "event_2", type: "input_audio_buffer.append", audio: "AQID" });
  });

  it("maps text + stash to partial, completed to final, and session.finished after finish to done", () => {
    const t = ready();
    t.ws.server({ type: "input_audio_buffer.speech_started", audio_start_ms: 64 });
    t.ws.server({ type: "conversation.item.input_audio_transcription.text", text: "今天", stash: "天气不错" });
    t.ws.server({ type: "conversation.item.input_audio_transcription.text", stash: "阳光" });
    t.ws.server({ type: "conversation.item.input_audio_transcription.completed", transcript: "今天天气不错，阳光明媚。" });
    t.stream.finish();
    expect(t.ws.sent.at(-1)).toEqual({ event_id: "event_2", type: "session.finish" });
    t.ws.server({ type: "session.finished" });
    t.ws.drop(1000);
    expect(t.events).toEqual([
      { type: "ready" },
      { type: "partial", text: "今天天气不错" },
      { type: "partial", text: "阳光" },
      { type: "final", text: "今天天气不错，阳光明媚。" },
      { type: "done" },
    ]);
    expect(t.ws.closed).toBe(1);
  });

  it("passes DashScope's error and a failed transcription on as error", () => {
    const failed = ready();
    failed.ws.server({ type: "conversation.item.input_audio_transcription.failed", error: { code: "Bad", message: "no speech" } });
    expect(failed.events.at(-1)).toEqual({ type: "error", message: "DashScope could not transcribe: Bad no speech" });
    expect(failed.ws.closed).toBe(1);
    const t = ready();
    t.ws.server({ type: "error", error: { code: "invalid_value", message: "bad sample_rate" } });
    t.ws.drop(1000);
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: "DashScope error: invalid_value bad sample_rate" }]);
  });

  it("drops a frame that is not JSON and keeps going", () => {
    const t = ready();
    t.ws.server("not json");
    t.ws.server({ type: "conversation.item.input_audio_transcription.completed", transcript: "ok" });
    expect(t.events).toEqual([{ type: "ready" }, { type: "final", text: "ok" }]);
    expect(log.warn).toHaveBeenCalledWith("DashScope sent a frame that is not JSON — dropped");
  });

  it("errors on a refused handshake, naming why the replay failed too, and on an unexpected close", async () => {
    const cause = new Error("getaddrinfo ENOTFOUND dashscope.aliyuncs.com");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed", { cause }))));
    const refused = start();
    refused.ws.fail();
    refused.ws.drop(1006);
    await vi.waitFor(() => expect(refused.events).toEqual([{ type: "error", message: "DashScope connection failed: TypeError: fetch failed (getaddrinfo ENOTFOUND dashscope.aliyuncs.com)" }]));
    const t = ready();
    t.ws.drop(1011, "internal");
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: "DashScope closed the connection (1011 internal)" }]);
  });

  it("errors when the session is not ready within 8 s, or not finished within 20 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = start();
    slow.ws.open();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(slow.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.events).toEqual([{ type: "error", message: "DashScope was not ready within 8 s" }]);
    expect(slow.ws.closed).toBe(1);
    // Late frames after the timeout are ignored.
    slow.ws.server({ type: "session.updated" });
    expect(slow.events).toHaveLength(1);

    const t = ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.events).toEqual([{ type: "ready" }]);
    t.stream.finish();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.events).toEqual([{ type: "ready" }, { type: "error", message: "DashScope did not finish within 20 s" }]);
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
