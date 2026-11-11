import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { AuthStore, requireAuth } from "./auth.js";
import { type AsrEvent, type AsrProvider, mockAsr, MOCK_SCRIPT, registerVoiceRoutes } from "./voice.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../log.js", () => ({ logger: () => log }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** A provider the test drives: `emit` is the last open's, `calls` what the route asked of it. */
function scripted(available = true) {
  const calls: string[] = [];
  let emit: (e: AsrEvent) => void = () => {};
  const provider: AsrProvider = {
    available: () => available,
    open(opts, e) {
      calls.push(`open ${opts.language ?? "-"}`);
      emit = e;
      return {
        audio: (pcm) => calls.push(`audio ${pcm.byteLength}`),
        finish: () => calls.push("finish"),
        close: () => calls.push("close"),
      };
    },
  };
  return { provider, calls, emit: (e: AsrEvent) => emit(e) };
}

function rig(provider: AsrProvider | undefined) {
  const auth = new AuthStore(openDb(":memory:"), () => {});
  const cookie = `pier_session=${auth.open("10.0.0.9", "a browser")}`;
  const other = `pier_session=${auth.open("10.0.0.8", "another browser")}`;
  const app = new Hono();
  app.use("*", requireAuth(auth));
  registerVoiceRoutes(app, provider);
  const send = (method: string, path: string, body?: BodyInit, as: string | null = cookie) =>
    app.request(path, { method, headers: as ? { cookie: as } : {}, ...(body === undefined ? {} : { body }) });
  const open = async (body = "{}"): Promise<string> => {
    const res = await send("POST", "/api/voice", body);
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  };
  return { app, send, open, other };
}

/** An SSE reader: `next` is the following event, undefined once the stream ended. */
function sse(res: Response) {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: AsrEvent[] = [];
  return {
    reader,
    async next(): Promise<AsrEvent | undefined> {
      while (!queued.length) {
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) queued.push(JSON.parse(data.slice(6)) as AsrEvent);
        }
      }
      return queued.shift();
    },
    async rest(): Promise<AsrEvent[]> {
      const all: AsrEvent[] = [];
      for (let e = await this.next(); e; e = await this.next()) all.push(e);
      return all;
    },
  };
}

const pcm = (bytes: number): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

describe("/api/voice", () => {
  it("sits behind the Console password", async () => {
    const r = rig(mockAsr);
    expect((await r.send("GET", "/api/voice", undefined, null)).status).toBe(401);
    expect((await r.send("POST", "/api/voice", "{}", null)).status).toBe(401);
  });

  it("answers whether voice input is available", async () => {
    const answer = async (provider: AsrProvider | undefined) => {
      const res = await rig(provider).send("GET", "/api/voice");
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    expect(await answer(mockAsr)).toEqual({ available: true });
    expect(await answer(scripted(false).provider)).toEqual({ available: false });
    expect(await answer(undefined)).toEqual({ available: false });
  });

  it("is 503 without a provider, or with one that is unavailable", async () => {
    for (const provider of [undefined, scripted(false).provider]) {
      const res = await rig(provider).send("POST", "/api/voice", "{}");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice input is not configured" });
    }
  });

  it("refuses a body that is not JSON and a language that is not a code", async () => {
    const s = scripted();
    const r = rig(s.provider);
    expect((await r.send("POST", "/api/voice", "{")).status).toBe(400);
    expect((await r.send("POST", "/api/voice", JSON.stringify({ language: 7 }))).status).toBe(400);
    expect((await r.send("POST", "/api/voice", JSON.stringify({ language: "zh; drop" }))).status).toBe(400);
    expect(s.calls).toEqual([]);
    await r.open(JSON.stringify({ language: "zh" }));
    expect(s.calls).toEqual(["open zh"]);
  });

  it("relays a take over mockAsr: audio in, partial and final out, finish, done", async () => {
    const r = rig(mockAsr);
    const id = await r.open();
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    expect(await events.next()).toEqual({ type: "ready" });
    const [first, second] = MOCK_SCRIPT as [string, string];
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(5 * 3_200))).status).toBe(202);
    expect(await events.next()).toEqual({ type: "partial", text: first.slice(0, 5) });
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm((first.length - 5 + 4) * 3_200))).status).toBe(202);
    expect(await events.next()).toEqual({ type: "final", text: first });
    expect(await events.next()).toEqual({ type: "partial", text: second.slice(0, 4) });
    expect((await r.send("POST", `/api/voice/${id}/finish`)).status).toBe(202);
    expect(await events.rest()).toEqual([{ type: "final", text: second.slice(0, 4) }, { type: "done" }]);
    // The take is gone once done.
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(2))).status).toBe(404);
    // Nothing heard reaches the log.
    const lines = [...log.info.mock.calls, ...log.warn.mock.calls].map(([line]) => String(line));
    expect(lines.some((line) => line.includes(second.slice(0, 4)) || line.includes(first))).toBe(false);
    expect(lines.some((line) => /ended after [\d.]+ s — done/.test(line))).toBe(true);
  });

  it("buffers audio until ready, flushes it in order, and sends a finish that came early after it", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    await r.send("POST", `/api/voice/${id}/audio`, pcm(4));
    await r.send("POST", `/api/voice/${id}/audio`, pcm(6));
    await r.send("POST", `/api/voice/${id}/finish`);
    expect(s.calls).toEqual(["open -"]);
    s.emit({ type: "ready" });
    expect(s.calls).toEqual(["open -", "audio 4", "audio 6", "finish"]);
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(2))).status).toBe(409);
  });

  it("fails the take when the buffer before ready overflows", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    for (let i = 0; i < 128; i++) expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(2))).status).toBe(202);
    const overflow = await r.send("POST", `/api/voice/${id}/audio`, pcm(2));
    expect(overflow.status).toBe(409);
    expect(s.calls.at(-1)).toBe("close");
    // The failure waits for the event stream that has not attached yet.
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    expect(await events.rest()).toEqual([{ type: "error", message: "the recognizer did not become ready before the audio buffer filled" }]);
  });

  it("refuses an audio body over 256 KB with 413 and keeps the take", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    s.emit({ type: "ready" });
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(256 * 1024 + 1))).status).toBe(413);
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(256 * 1024))).status).toBe(202);
    expect(s.calls).toEqual(["open -", `audio ${256 * 1024}`]);
  });

  it("cancels on DELETE: the provider closes and the stream ends with nothing", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    s.emit({ type: "ready" });
    expect(await events.next()).toEqual({ type: "ready" });
    expect((await r.send("DELETE", `/api/voice/${id}`)).status).toBe(204);
    expect(await events.rest()).toEqual([]);
    expect(s.calls).toEqual(["open -", "close"]);
    expect((await r.send("DELETE", `/api/voice/${id}`)).status).toBe(404);
  });

  it("cancels when the event stream is dropped", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    s.emit({ type: "ready" });
    expect(await events.next()).toEqual({ type: "ready" });
    await events.reader.cancel();
    await vi.waitFor(() => expect(s.calls).toEqual(["open -", "close"]));
    expect((await r.send("POST", `/api/voice/${id}/audio`, pcm(2))).status).toBe(404);
  });

  it("is 404 to another browser on every take route, and 409 to a second event stream", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    for (const [method, path] of [
      ["GET", `/api/voice/${id}/events`],
      ["POST", `/api/voice/${id}/audio`],
      ["POST", `/api/voice/${id}/finish`],
      ["DELETE", `/api/voice/${id}`],
    ] as const) {
      const res = await r.send(method, path, method === "POST" ? pcm(2) : undefined, r.other);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no such voice take" });
    }
    expect((await r.send("POST", "/api/voice/not-a-take/finish")).status).toBe(404);
    expect(s.calls).toEqual(["open -"]);
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    expect((await r.send("GET", `/api/voice/${id}/events`)).status).toBe(409);
    await events.reader.cancel();
  });

  it("closes a browser's previous take when it opens another, with an error on the old stream", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const first = await r.open();
    const events = sse(await r.send("GET", `/api/voice/${first}/events`));
    const second = await r.open();
    expect(second).not.toBe(first);
    expect(await events.rest()).toEqual([{ type: "error", message: "another voice take started in this browser" }]);
    expect(s.calls).toEqual(["open -", "close", "open -"]);
    // Another browser's take is not this one's to close.
    await r.send("POST", "/api/voice", "{}", r.other);
    expect(s.calls).toEqual(["open -", "close", "open -", "open -"]);
  });

  it("ends the take with an upstream error, and refuses it afterwards", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    s.emit({ type: "ready" });
    s.emit({ type: "partial", text: "x" });
    s.emit({ type: "error", message: "DashScope error: quota" });
    expect(await events.rest()).toEqual([
      { type: "ready" },
      { type: "partial", text: "x" },
      { type: "error", message: "DashScope error: quota" },
    ]);
    expect(s.calls).toEqual(["open -", "close"]);
    expect((await r.send("POST", `/api/voice/${id}/finish`)).status).toBe(404);
  });

  it("keeps only the latest partial for a stream that has not attached yet", async () => {
    const s = scripted();
    const r = rig(s.provider);
    const id = await r.open();
    s.emit({ type: "ready" });
    s.emit({ type: "partial", text: "a" });
    s.emit({ type: "partial", text: "ab" });
    s.emit({ type: "final", text: "abc" });
    s.emit({ type: "partial", text: "d" });
    const events = sse(await r.send("GET", `/api/voice/${id}/events`));
    expect([await events.next(), await events.next(), await events.next()]).toEqual([
      { type: "ready" },
      { type: "partial", text: "ab" },
      { type: "final", text: "abc" },
    ]);
    expect(await events.next()).toEqual({ type: "partial", text: "d" });
    await events.reader.cancel();
  });

  it("errors after 15 s with no audio and no finish, and after 5 minutes regardless", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const s = scripted();
    const r = rig(s.provider);
    const idle = await r.open();
    s.emit({ type: "ready" });
    await vi.advanceTimersByTimeAsync(14_000);
    await r.send("POST", `/api/voice/${idle}/audio`, pcm(2));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(s.calls.at(-1)).toBe("audio 2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.calls.at(-1)).toBe("close");
    expect(await sse(await r.send("GET", `/api/voice/${idle}/events`)).rest()).toEqual([
      { type: "ready" },
      { type: "error", message: "no audio for 15 s" },
    ]);

    const long = await r.open();
    s.emit({ type: "ready" });
    for (let t = 0; t < 300; t += 10) {
      await r.send("POST", `/api/voice/${long}/audio`, pcm(2));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(s.calls.at(-1)).toBe("close");
    const events = await sse(await r.send("GET", `/api/voice/${long}/events`)).rest();
    expect(events.at(-1)).toEqual({ type: "error", message: "a voice take is limited to 5 minutes" });
  });
});
