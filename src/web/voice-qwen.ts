// The DashScope qwen3-asr-flash-realtime adapter: the one file that knows its
// WebSocket protocol (help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
// and …-server-events).

import { logger } from "../log.js";
import { type AsrProvider, NodeWebSocket, type SocketCtor, socketAsr, type Wire } from "./voice.js";

const log = logger("voice");

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime";

/** Only the fields the mapping reads; anything else in the event is ignored. */
interface ServerEvent {
  type?: unknown;
  text?: unknown;
  stash?: unknown;
  transcript?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function qwenAsr(readKey: () => string | undefined, Socket: SocketCtor = NodeWebSocket): AsrProvider {
  return socketAsr("DashScope", "DASHSCOPE_API_KEY", readKey, Socket, (key, opts): Wire => {
    let events = 0;
    const json = (event: Record<string, unknown>): string => JSON.stringify({ event_id: `event_${++events}`, ...event });
    return {
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${key}`, "OpenAI-Beta": "realtime=v1" },
      start: json({
        type: "session.update",
        session: {
          input_audio_format: "pcm",
          sample_rate: 16000,
          ...(opts.language ? { input_audio_transcription: { language: opts.language } } : {}),
          turn_detection: { type: "server_vad", threshold: 0.0, silence_duration_ms: 400 },
        },
      }),
      audio: (pcm) => json({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") }),
      finish: () => json({ type: "session.finish" }),
      message(data, take) {
        let e: ServerEvent;
        try {
          e = JSON.parse(String(data)) as ServerEvent;
        } catch {
          log.warn("DashScope sent a frame that is not JSON — dropped");
          return;
        }
        switch (e.type) {
          case "session.updated":
            return take.ready();
          case "conversation.item.input_audio_transcription.text":
            return take.emit({ type: "partial", text: str(e.text) + str(e.stash) });
          case "conversation.item.input_audio_transcription.completed":
            return take.emit({ type: "final", text: str(e.transcript) });
          case "conversation.item.input_audio_transcription.failed":
            return take.fail(`DashScope could not transcribe: ${str(e.error?.code)} ${str(e.error?.message)}`.trim());
          case "error":
            return take.fail(`DashScope error: ${str(e.error?.code)} ${str(e.error?.message)}`.trim());
          case "session.finished":
            return take.done();
        }
      },
    };
  });
}
