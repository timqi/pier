// Pure Pi-event → SessionEventPayload translation. Structurally typed on
// purpose: no @earendil-works/pi-* imports, so it stays unit-testable without Pi
// and Pi types never leak past the seam. See docs/design/02-agent-seam.md.

import type { SessionEventPayload } from "../core/types.js";

interface TextPart {
  type: string;
  text?: string;
}

export interface PiMessage {
  role?: string;
  content?: string | TextPart[];
  stopReason?: string;
  errorMessage?: string;
}

export interface PiEvent {
  type: string;
  messages?: PiMessage[];
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: { content?: TextPart[] };
  steering?: readonly string[];
  followUp?: readonly string[];
}

export function textOf(content: string | TextPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function lastAssistant(messages: PiMessage[] | undefined): PiMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/** Translate one Pi session event into zero or more Pier payloads. */
export function toSessionEvents(e: PiEvent): SessionEventPayload[] {
  switch (e.type) {
    case "agent_start":
      return [{ type: "state", state: "streaming" }, { type: "turn-start" }];
    case "agent_end": {
      const final = lastAssistant(e.messages);
      const out: SessionEventPayload[] = [
        { type: "turn-end", text: textOf(final?.content) },
      ];
      if (final?.stopReason === "error") {
        out.push({ type: "error", message: final.errorMessage ?? "unknown agent error" });
      }
      out.push({ type: "state", state: "idle" });
      return out;
    }
    case "message_update": {
      const ame = e.assistantMessageEvent;
      if (ame?.type === "text_delta" && ame.delta) {
        return [{ type: "text-delta", text: ame.delta }];
      }
      if (ame?.type === "thinking_delta" && ame.delta) {
        return [{ type: "thinking-delta", text: ame.delta }];
      }
      return [];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool-start",
          toolCallId: e.toolCallId ?? "",
          toolName: e.toolName ?? "",
          args: e.args,
        },
      ];
    case "queue_update":
      return [
        {
          type: "queue-state",
          steering: [...(e.steering ?? [])],
          followUp: [...(e.followUp ?? [])],
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool-end",
          toolCallId: e.toolCallId ?? "",
          isError: e.isError ?? false,
          output: textOf(e.result?.content),
        },
      ];
    default:
      return [];
  }
}
