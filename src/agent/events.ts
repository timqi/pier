// Pure Pi-event → SessionEventPayload translation. Structurally typed: no Pi
// imports, so it is unit-testable without Pi and Pi types never leak past the
// seam. The golden table in events.test.ts is the mapping's spec.

import { isThinkingLevel, MAX_STEP_OUTPUT } from "../core/types.js";
import type {
  ActivityStep,
  ChatTurn,
  SessionEventPayload,
  SystemInputOrigin,
  SystemInputSource,
  TurnMeta,
} from "../core/types.js";

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
  // One field, two events: a tool's result content, and compaction's token counts.
  result?: { content?: TextPart[]; tokensBefore?: number; estimatedTokensAfter?: number };
  errorMessage?: string;
  steering?: readonly string[];
  followUp?: readonly string[];
  // agent_end: Pi's own auto-retry will continue this turn.
  willRetry?: boolean;
}

/** An assistant message that calls a tool is work in progress, not a reply. */
export const hasToolCalls = (message: PiMessage | undefined): boolean =>
  Array.isArray(message?.content) && message.content.some((part) => part.type === "toolCall");

export function textOf(content: string | TextPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}


function systemOrigin(message: PiMessage): SystemInputOrigin | null {
  if (message.role !== "custom" || message.customType !== "pier.system-input") return null;
  const value = message.details;
  if (!value || typeof value !== "object") return null;
  const { source: raw, ...origin } = value as Record<string, unknown>;
  if (
    typeof origin.taskId !== "string" ||
    typeof origin.runId !== "string" ||
    (origin.sourceSessionId !== null && typeof origin.sourceSessionId !== "string")
  ) return null;
  // A half-valid `source` drawn by the card is an `undefined` in a chip.
  const source = inputSource(raw);
  const shape = { ...origin, ...(source ? { source } : {}) };
  if (origin.kind === "task-delegation" || origin.kind === "task-callback") {
    return shape as SystemInputOrigin;
  }
  if (
    origin.kind === "task-message" &&
    typeof origin.messageId === "string" &&
    (origin.messageKind === "steer" || origin.messageKind === "follow_up" ||
      origin.messageKind === "progress" || origin.messageKind === "decision" || origin.messageKind === "reply")
  ) return shape as SystemInputOrigin;
  return null;
}

function inputSource(value: unknown): SystemInputSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { taskName, model, thinking } = value as Record<string, unknown>;
  if (typeof taskName !== "string") return undefined;
  const ref = (model ?? {}) as Record<string, unknown>;
  return {
    taskName,
    ...(typeof ref.provider === "string" && typeof ref.id === "string"
      ? { model: { provider: ref.provider, id: ref.id } }
      : {}),
    ...(isThinkingLevel(thinking) ? { thinking } : {}),
  };
}

/** `length`, `aborted` and `error` are Pi's to recover from (a truncated answer
 *  is compacted and asked again), so they stay on the `agent_end` path. */
const isAnswer = (m: PiMessage | undefined): boolean =>
  m?.role === "assistant" && m.stopReason === "stop" && !hasToolCalls(m);

function lastAssistant(messages: PiMessage[] | undefined): PiMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/** Pi stamps a message's timestamp at stream start, so a live turn-end passes
 *  its own `completedAt`. `tokens` is not a sum: each `totalTokens` already
 *  covers the whole request. */
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

/** The renderable transcript, activity included, so a reload shows the same
 *  step counts the live stream built. */
export function toChatTurns(messages: PiMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let steps: ActivityStep[] = []; // activity seen since the last emitted turn
  const pendingTools = new Map<string, ActivityStep>();
  let candidate: ChatTurn | undefined; // text-only reply, until another assistant message follows

  const flush = (
    role: ChatTurn["role"],
    text: string,
    meta?: TurnMeta,
    origin?: SystemInputOrigin,
    at?: number,
  ): void => {
    const turn: ChatTurn = { role, text };
    if (meta) turn.meta = meta;
    if (origin) turn.origin = origin;
    // An assistant turn's meta says when it finished; user and system turns
    // would have no time at all after a reload.
    if (at !== undefined && role !== "assistant") turn.at = at;
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
        // Capped here: a long session's tool results are megabytes nobody sees.
        const output = textOf(m.content);
        step.output = output.length > MAX_STEP_OUTPUT ? output.slice(0, MAX_STEP_OUTPUT) + "…" : output;
        step.isError = m.isError ?? false;
        step.done = true;
        pendingTools.delete(m.toolCallId ?? "");
      }
      continue;
    }
    const origin = systemOrigin(m);
    if (origin) {
      candidate = undefined;
      const text = textOf(m.content);
      if (text) flush("system", text, undefined, origin, m.timestamp);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "user") candidate = undefined;
    else if (candidate) {
      // Some providers separate commentary from the following tool-call message.
      turns.pop();
      steps = candidate.steps ?? [];
      steps.push({ kind: "progress", text: candidate.text });
      candidate = undefined;
    }

    const hasTools = m.role === "assistant" && hasToolCalls(m);
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (hasTools && part.type === "text" && part.text) {
          steps.push({ kind: "progress", text: part.text });
        } else if (part.type === "thinking" && part.thinking) {
          steps.push({ kind: "thinking", text: part.thinking });
        } else if (part.type === "toolCall") {
          const step: ActivityStep = {
            kind: "tool",
            id: part.id,
            toolName: part.name ?? "",
            args: part.arguments,
          };
          steps.push(step);
          if (part.id) pendingTools.set(part.id, step);
        }
      }
    }

    const text = textOf(m.content);
    // Tool-bearing messages are intermediate work, even when they include text.
    if (!text || hasTools) continue;
    flush(m.role, text, m.role === "assistant" ? turnMetaAt(messages, i) : undefined, undefined, m.timestamp);
    if (m.role === "assistant") candidate = turns[turns.length - 1];
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
    // One turn-end per answer, not per run: Pi drains a queued follow-up
    // inside the run and emits a single agent_end for all of it.
    case "turn_end":
      return isAnswer(e.message) ? [{ type: "turn-end", text: textOf(e.message?.content) }] : [];
    case "agent_end": {
      // Pi emits one agent_end per retry attempt; only the last ends the turn.
      if (e.willRetry) return [];
      const final = lastAssistant(e.messages);
      // An answer ended its own turn above; what is left is every way a run
      // ends without one.
      if (isAnswer(final)) return [];
      // Carried twice: on turn-end because it is how the turn ended (what a
      // task run settles on), and as the error event every chat surface reports.
      const failure = final?.stopReason === "error"
        ? final.errorMessage || "unknown agent error"
        : undefined;
      const out: SessionEventPayload[] = [
        { type: "turn-end", text: hasToolCalls(final) ? "" : textOf(final?.content), ...(failure ? { error: failure } : {}) },
      ];
      if (failure) out.push({ type: "error", message: failure });
      return out;
    }
    // Pi clears `isStreaming` one statement before emitting this, many
    // microtasks after the last `agent_end`; idle rides on it so the `state`
    // getter and this stream agree. Auto-compaction runs past `agent_end` too.
    case "agent_settled":
      return [{ type: "state", state: "idle" }];
    case "message_start": {
      const m = e.message;
      if (!m) return [];
      if (m.role === "assistant") return [{ type: "text-start" }];
      const origin = systemOrigin(m);
      if (!origin && m.role !== "user") return [];
      // A message Pi drains mid-run opens a turn `agent_start` never announces.
      // On the message, not its text: an attachment with no caption is still a turn.
      const out: SessionEventPayload[] = [{ type: "turn-start" }];
      const text = textOf(m.content);
      if (text) out.push(origin ? { type: "system-input", text, origin } : { type: "user-message", text });
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
    case "compaction_end": {
      // The only trace compaction leaves: `toChatTurns` renders nothing for the
      // summary message (§5).
      const r = e.result;
      if (r && typeof r.tokensBefore === "number") {
        return [{
          type: "context-compacted",
          before: r.tokensBefore,
          after: r.estimatedTokensAfter ?? r.tokensBefore,
        }];
      }
      // No result: cancelled or failed. An automatic compaction has no route
      // to report through; this is all it has.
      return [{ type: "error", message: e.errorMessage ?? "compaction cancelled" }];
    }
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
