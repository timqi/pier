// The voice take's capture processor: the microphone's channels averaged to
// mono, box-averaged down to 16 kHz, PCM16LE posted to ui/voice.ts a 250 ms
// frame at a time; `flush` posts the short last frame, then `flushed`.

/*! Resampling after Avibe's capture worklet. Copyright (c) 2026 The Vibe Remote
    Authors, MIT licence: src/web/ui/voice.LICENSE-avibe. */

// The AudioWorkletGlobalScope, which TypeScript's DOM lib does not declare;
// scoped to this module by the `export {}` below.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const RATE = 16_000;
const FRAME = RATE / 4;

registerProcessor("pier-voice", class extends AudioWorkletProcessor {
  private frame = new Int16Array(FRAME);
  private filled = 0;
  // Input samples accumulate until the 16 kHz clock ticks past `sampleRate`.
  private phase = 0;
  private sum = 0;
  private count = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      if (ev.data !== "flush") return;
      this.post(this.frame.slice(0, this.filled));
      this.port.postMessage("flushed");
    };
  }

  private post(frame: Int16Array): void {
    if (frame.length) this.port.postMessage(frame.buffer, [frame.buffer]);
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0] ?? [];
    const length = channels[0]?.length ?? 0;
    for (let i = 0; i < length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] ?? 0;
      this.sum += mono / channels.length;
      this.count++;
      this.phase += RATE;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      this.frame[this.filled++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      this.sum = 0;
      this.count = 0;
      if (this.filled === FRAME) this.post(this.frame);
    }
    return true;
  }
});

export {};
