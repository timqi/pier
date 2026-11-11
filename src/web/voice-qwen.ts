// The DashScope qwen3-asr-flash-realtime adapter: the one file that knows its
// WebSocket protocol (help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
// and …-server-events).

import { logger } from "../log.js";
import type { AsrEvent, AsrProvider, AsrStream } from "./voice.js";

const log = logger("voice");

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime";
const HANDSHAKE_MS = 8_000;
const FINISH_MS = 20_000;

type Socket = Pick<WebSocket, "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose">;
/** The global `WebSocket` in production; a fake in tests. */
export type SocketCtor = new (url: string, init: { headers: Record<string, string> }) => Socket;
// Node's WebSocket (undici) takes `{ headers }`; the DOM lib this program
// compiles against types only `protocols` there.
const NodeWebSocket = WebSocket as unknown as SocketCtor;

/** Only the fields the mapping reads; anything else in the event is ignored. */
interface ServerEvent {
  type?: unknown;
  text?: unknown;
  stash?: unknown;
  transcript?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `readKey` is `vault.get`: it throws while the vault is locked, and an
 *  approve-level row is a `vt://` record, not a key. Either is "unavailable". */
export function qwenAsr(readKey: () => string | undefined, Socket: SocketCtor = NodeWebSocket): AsrProvider {
  let warned = "";
  const key = (): string | undefined => {
    let problem: string;
    try {
      const value = readKey();
      if (value && !value.startsWith("vt://")) {
        warned = "";
        return value;
      }
      problem = value ? "is an approve-level vt:// record; voice input needs an auto row" : "is not in the vault";
    } catch (err) {
      problem = `cannot be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    // One line per change of state, not one per availability check.
    if (problem !== warned) log.warn(`DASHSCOPE_API_KEY ${problem} — voice input is off`);
    warned = problem;
    return undefined;
  };

  return {
    available: () => key() !== undefined,
    open(opts, emit) {
      let state: "connecting" | "ready" | "finishing" | "closed" = "connecting";
      let events = 0;
      let ws: Socket | undefined;
      let timer: NodeJS.Timeout | undefined;

      const stop = (event: AsrEvent): void => {
        if (state === "closed") return;
        state = "closed";
        clearTimeout(timer);
        ws?.close();
        emit(event);
      };
      const fail = (message: string): void => stop({ type: "error", message });
      const send = (event: Record<string, unknown>): void => {
        try {
          ws?.send(JSON.stringify({ event_id: `event_${++events}`, ...event }));
        } catch (err) {
          fail(`DashScope send failed: ${String(err)}`);
        }
      };

      const apiKey = key();
      if (!apiKey) {
        queueMicrotask(() => fail("DASHSCOPE_API_KEY is not available"));
      } else {
        try {
          ws = new Socket(ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" } });
        } catch (err) {
          queueMicrotask(() => fail(`DashScope connection failed: ${String(err)}`));
        }
      }
      if (ws) {
        timer = setTimeout(() => fail(`DashScope was not ready within ${HANDSHAKE_MS / 1000} s`), HANDSHAKE_MS);
        ws.onopen = () => {
          send({
            type: "session.update",
            session: {
              input_audio_format: "pcm",
              sample_rate: 16000,
              ...(opts.language ? { input_audio_transcription: { language: opts.language } } : {}),
              turn_detection: { type: "server_vad", threshold: 0.0, silence_duration_ms: 400 },
            },
          });
        };
        ws.onmessage = (m) => {
          let e: ServerEvent;
          try {
            e = JSON.parse(String(m.data)) as ServerEvent;
          } catch {
            log.warn("DashScope sent a frame that is not JSON — dropped");
            return;
          }
          if (state === "closed") return;
          switch (e.type) {
            case "session.updated":
              if (state !== "connecting") return;
              clearTimeout(timer);
              state = "ready";
              return emit({ type: "ready" });
            case "conversation.item.input_audio_transcription.text":
              return emit({ type: "partial", text: str(e.text) + str(e.stash) });
            case "conversation.item.input_audio_transcription.completed":
              return emit({ type: "final", text: str(e.transcript) });
            case "conversation.item.input_audio_transcription.failed":
              return fail(`DashScope could not transcribe: ${str(e.error?.code)} ${str(e.error?.message)}`.trim());
            case "error":
              return fail(`DashScope error: ${str(e.error?.code)} ${str(e.error?.message)}`.trim());
            case "session.finished":
              return stop({ type: "done" });
          }
        };
        // A rejected key fails the handshake itself (HTTP 401/403): error, then close.
        ws.onerror = () => fail("DashScope connection failed");
        ws.onclose = (c) => fail(`DashScope closed the connection (${c.code}${c.reason ? ` ${c.reason}` : ""})`);
      }

      const stream: AsrStream = {
        audio(pcm) {
          if (state !== "ready") return;
          send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
        },
        finish() {
          if (state !== "ready") return;
          state = "finishing";
          timer = setTimeout(() => fail(`DashScope did not finish within ${FINISH_MS / 1000} s`), FINISH_MS);
          send({ type: "session.finish" });
        },
        close() {
          if (state === "closed") return;
          state = "closed";
          clearTimeout(timer);
          ws?.close();
        },
      };
      return stream;
    },
  };
}
