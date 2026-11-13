// The Doubao streaming ASR 2.0 adapter (Volcengine sauc bigmodel_async): the one
// file that knows its binary WebSocket protocol (docs.volcengine.com/docs/doubao-voice/
// bidirectional-streaming-automatic-speech-recognition-websocket and the frame
// layout in …/large-model-streaming-automatic-speech-recognition-api-1).

import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { logger } from "../log.js";
import { type AsrProvider, NodeWebSocket, type SocketCtor, socketAsr, type Wire, type WireTake } from "./voice.js";

const log = logger("voice");

const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
/** Doubao streaming ASR 2.0, billed by the hour. */
const RESOURCE_ID = "volc.seedasr.sauc.duration";

const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR = 0b1111;
const FLAG_SEQUENCE = 0b0001;
const FLAG_LAST = 0b0010;
const JSON_SERIALIZATION = 0b0001;
const GZIP = 0b0001;

/** Version 1, a 4-byte header, no compression; the payload's size big-endian after it. */
function frame(type: number, flags: number, serialization: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.byteLength);
  out.set([0x11, (type << 4) | flags, serialization << 4, 0]);
  new DataView(out.buffer).setUint32(4, payload.byteLength);
  out.set(payload, 8);
  return out;
}

type ServerFrame = { type: "response"; last: boolean; body: unknown } | { type: "error"; code: number; message: string };

/** Throws on a frame shorter than its own sizes say. */
function parse(data: ArrayBuffer): ServerFrame | undefined {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const type = bytes[1]! >> 4;
  const flags = bytes[1]! & 0x0f;
  let at = (bytes[0]! & 0x0f) * 4;
  const payloadAt = (): Uint8Array => {
    const size = view.getUint32(at);
    if (at + 4 + size > bytes.byteLength) throw new RangeError("payload past the frame's end");
    const payload = bytes.subarray(at + 4, at + 4 + size);
    return (bytes[2]! & 0x0f) === GZIP ? gunzipSync(payload) : payload;
  };
  if (type === SERVER_ERROR) {
    const code = view.getUint32(at);
    at += 4;
    return { type: "error", code, message: new TextDecoder().decode(payloadAt()) };
  }
  if (type !== FULL_SERVER_RESPONSE) return undefined;
  if (flags & FLAG_SEQUENCE) at += 4;
  const payload = payloadAt();
  return { type: "response", last: (flags & FLAG_LAST) !== 0, body: payload.byteLength ? JSON.parse(new TextDecoder().decode(payload)) : {} };
}

interface Utterance { text?: unknown; definite?: unknown }

function utterancesOf(body: unknown): Utterance[] {
  const result = (body as { result?: unknown } | null)?.result;
  const first = Array.isArray(result) ? result[0] : result;
  const list = (first as { utterances?: unknown } | null | undefined)?.utterances;
  return Array.isArray(list) ? (list as Utterance[]) : [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function doubaoAsr(readKey: () => string | undefined, Socket: SocketCtor = NodeWebSocket): AsrProvider {
  // bigmodel_async takes no language: the model detects it, so the client's is not passed on.
  return socketAsr("Doubao", "DOUBAO_ASR_API_KEY", readKey, Socket, (key): Wire => {
    /** Utterances already emitted as final, and the partial last shown after them. */
    let settled = 0;
    let partial = "";

    // result_type "full" resends every utterance each time; the definite prefix
    // grows and never changes, so its length is how much has been emitted.
    const onResponse = (body: unknown, last: boolean, take: WireTake): void => {
      const utterances = utterancesOf(body);
      // A response without utterances (audio_info only) says nothing about the text shown.
      if (!utterances.length) return;
      while (settled < utterances.length) {
        const utterance = utterances[settled]!;
        if (utterance.definite !== true && !last) break;
        const text = str(utterance.text);
        if (text) take.emit({ type: "final", text });
        else if (partial) take.emit({ type: "partial", text: "" });
        partial = "";
        settled++;
      }
      const rest = utterances.slice(settled).map((u) => str(u.text)).join("");
      if (rest !== partial) {
        partial = rest;
        take.emit({ type: "partial", text: rest });
      }
    };

    const request = {
      audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_nonstream: true, show_utterances: true, result_type: "full" },
    };
    return {
      url: ENDPOINT,
      headers: { "X-Api-Key": key, "X-Api-Resource-Id": RESOURCE_ID, "X-Api-Request-Id": randomUUID() },
      binaryType: "arraybuffer",
      start: frame(FULL_CLIENT_REQUEST, 0, JSON_SERIALIZATION, new TextEncoder().encode(JSON.stringify(request))),
      // The request travels ahead of the audio on the same socket, so audio may follow at once.
      readyOnOpen: true,
      audio: (pcm) => frame(AUDIO_ONLY_REQUEST, 0, 0, pcm),
      finish: () => frame(AUDIO_ONLY_REQUEST, FLAG_LAST, 0, new Uint8Array(0)),
      message(data, take) {
        let f: ServerFrame | undefined;
        try {
          if (!(data instanceof ArrayBuffer)) throw new TypeError("not a binary frame");
          f = parse(data);
        } catch (err) {
          log.warn(`Doubao sent a frame that does not parse (${String(err)}) — dropped`);
          return;
        }
        if (!f) return log.warn("Doubao sent a frame of an unknown message type — ignored");
        if (f.type === "error") return take.fail(`Doubao error ${f.code}: ${f.message}`);
        onResponse(f.body, f.last, take);
        if (f.last) take.done();
      },
    };
  });
}
