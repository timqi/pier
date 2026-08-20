// Pure Pi-event → SessionEventPayload translation. Structurally typed on
// purpose: no @earendil-works/pi-* imports, so it stays unit-testable without Pi
// and Pi types never leak past the seam. The golden-table test in
// events.test.ts is the mapping's spec; extend types.ts before adding events.

import type {
  ActivityStep,
  ChatTurn,
  SessionEventPayload,
  SystemInputOrigin,
  TurnMeta,
} from "../core/types.js";

/** Union of the assistant content blocks we care about (text/thinking/toolCall). */
interface TextPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string; // toolCall
  name?: string; // toolCall
  arguments?: unknown; // toolCall
}

export interface PiMessage {
  role?: string;
  content?: string | TextPart[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number; // ms epoch, stamped by Pi at message creation
  usage?: { totalTokens?: number };
  // toolResult messages
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // persisted custom messages
  customType?: string;
  details?: unknown;
}

export interface PiEvent {
  type: string;
  message?: PiMessage;
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

/** Renderable text of a message, with an image marker (binaries aren't served). */
function displayText(m: PiMessage): string {
  const text = textOf(m.content);
  const images = Array.isArray(m.content)
    ? m.content.filter((p) => p.type === "image").length
    : 0;
  if (!images) return text;
  return `${text}${text ? " " : ""}[${images} image${images > 1 ? "s" : ""}]`;
}

function systemOrigin(message: PiMessage): SystemInputOrigin | null {
  if (message.role !== "custom" || message.customType !== "pier.system-input") return null;
  const value = message.details;
  if (!value || typeof value !== "object") return null;
  const origin = value as Record<string, unknown>;
  if (
    typeof origin.taskId !== "string" ||
    typeof origin.runId !== "string" ||
    (origin.sourceSessionId !== null && typeof origin.sourceSessionId !== "string")
  ) return null;
  if (origin.kind === "task-delegation" || origin.kind === "task-callback") {
    return origin as SystemInputOrigin;
  }
  if (
    origin.kind === "task-message" &&
    typeof origin.messageId === "string" &&
    (origin.messageKind === "steer" || origin.messageKind === "follow_up" ||
      origin.messageKind === "progress" || origin.messageKind === "decision" || origin.messageKind === "reply")
  ) return origin as SystemInputOrigin;
  return null;
}

function lastAssistant(messages: PiMessage[] | undefined): PiMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * Completion metadata for the assistant message at `index` (bubble hover
 * hints). `completedAt` defaults to the message's own timestamp — Pi stamps
 * that at stream start, so callers with a real clock (live turn-end) pass
 * their own; history accepts the approximation.
 *
 * `tokens` is the context size at that point, not a sum: each assistant
 * message's `totalTokens` already covers the whole request (prompt + cache +
 * output), so adding them up double-counts the context on every turn. Pi
 * itself reads context usage off the last assistant message the same way.
 */
export function turnMetaAt(
  messages: PiMessage[],
  index: number,
  completedAt?: number,
): TurnMeta | undefined {
  const m = messages[index];
  if (m?.role !== "assistant" || typeof m.timestamp !== "number") return undefined;
  const end = completedAt ?? m.timestamp;
  let started = end;
  for (let i = index - 1; i >= 0; i--) {
    const t = messages[i];
    if (t && (t.role === "user" || systemOrigin(t) !== null) && typeof t.timestamp === "number") {
      started = t.timestamp;
      break;
    }
  }
  let tokens = 0;
  for (let i = index; i >= 0; i--) {
    const t = messages[i];
    if (t?.role === "assistant" && t.usage?.totalTokens) {
      tokens = t.usage.totalTokens;
      break;
    }
  }
  return { completedAt: end, durationMs: Math.max(0, end - started), tokens };
}

/**
 * Rebuild the renderable transcript: user/assistant turns plus the activity
 * (thinking + tool calls) that preceded each assistant answer. This is what
 * makes a page reload show the real step counts instead of restarting at zero.
 */
export function toChatTurns(messages: PiMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let steps: ActivityStep[] = []; // activity seen since the last emitted turn
  const pendingTools = new Map<string, ActivityStep>();

  const flush = (
    role: ChatTurn["role"],
    text: string,
    meta?: TurnMeta,
    origin?: SystemInputOrigin,
  ): void => {
    const turn: ChatTurn = { role, text };
    if (meta) turn.meta = meta;
    if (origin) turn.origin = origin;
    if (steps.length) {
      turn.steps = steps;
      steps = [];
    }
    turns.push(turn);
  };

  for (const [i, m] of messages.entries()) {
    if (m.role === "toolResult") {
      const step = pendingTools.get(m.toolCallId ?? "");
      if (step) {
        step.output = textOf(m.content);
        step.isError = m.isError ?? false;
        pendingTools.delete(m.toolCallId ?? "");
      }
      continue;
    }
    const origin = systemOrigin(m);
    if (origin) {
      const text = displayText(m);
      if (text) flush("system", text, undefined, origin);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;

    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "thinking" && part.thinking) {
          steps.push({ kind: "thinking", text: part.thinking });
        } else if (part.type === "toolCall") {
          const step: ActivityStep = {
            kind: "tool",
            toolName: part.name ?? "",
            args: part.arguments,
          };
          steps.push(step);
          if (part.id) pendingTools.set(part.id, step);
        }
      }
    }

    const text = displayText(m);
    if (!text) continue; // step-only assistant messages keep buffering activity
    flush(m.role, text, m.role === "assistant" ? turnMetaAt(messages, i) : undefined);
  }
  // Activity with no answer after it (aborted run) still belongs on the page.
  if (steps.length) flush("assistant", "");
  return turns;
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
    case "message_start": {
      // Pi emits this for every message entering the context; the user ones are
      // what a client can't know about (queued/steered messages, IM traffic).
      const m = e.message;
      if (!m) return [];
      const origin = systemOrigin(m);
      const text = displayText(m);
      if (origin) return text ? [{ type: "system-input", text, origin }] : [];
      if (m.role !== "user") return [];
      return text ? [{ type: "user-message", text }] : [];
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
