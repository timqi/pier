// The capture processor under a fake AudioWorkletGlobalScope: downmix, resampling, framing, flush.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Processor = { port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((ev: { data: unknown }) => void) | null }; process(inputs: Float32Array[][]): boolean };
let Registered: new () => Processor;

async function load(rate: number): Promise<Processor> {
  vi.resetModules();
  vi.stubGlobal("sampleRate", rate);
  vi.stubGlobal("AudioWorkletProcessor", class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal("registerProcessor", (name: string, ctor: typeof Registered) => {
    expect(name).toBe("pier-voice");
    Registered = ctor;
  });
  await import("./voice-worklet.js");
  return new Registered();
}

/** `seconds` of input in 128-sample render quanta, each channel a constant. */
function feed(p: Processor, seconds: number, rate: number, ...levels: number[]): void {
  for (let left = Math.round(rate * seconds); left > 0; left -= 128) {
    const n = Math.min(128, left);
    p.process([levels.map((v) => new Float32Array(n).fill(v))]);
  }
}
const frames = (p: Processor): Int16Array[] =>
  p.port.postMessage.mock.calls.flatMap(([data]) => (data instanceof ArrayBuffer ? [new Int16Array(data)] : []));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it("averages the channels to mono and posts 4000 PCM16 samples per 250 ms at 16 kHz", async () => {
  const p = await load(48_000);
  feed(p, 0.5, 48_000, 1, 0);
  const out = frames(p);
  expect(out.map((f) => f.length)).toEqual([4000, 4000]);
  expect(out[0]!.every((s) => s === Math.round(0.5 * 32767))).toBe(true);
  // The buffer is transferred, not copied.
  expect(p.port.postMessage.mock.calls[0]![1]).toEqual([out[0]!.buffer]);
});

it("resamples 44.1 kHz exactly and clamps to the PCM16 range", async () => {
  const p = await load(44_100);
  feed(p, 1, 44_100, -2);
  const out = frames(p);
  expect(out.reduce((n, f) => n + f.length, 0)).toBe(16_000);
  expect(out[0]![0]).toBe(-32768);
});

it("posts the short last frame and then `flushed` on a flush", async () => {
  const p = await load(16_000);
  feed(p, 0.1, 16_000, 0.25);
  p.port.onmessage!({ data: "flush" });
  const out = frames(p);
  expect(out.map((f) => f.length)).toEqual([1600]);
  expect(p.port.postMessage.mock.calls.at(-1)).toEqual(["flushed"]);
});
