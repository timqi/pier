// The whole queue policy. Fixed by docs/architecture.md — do not add options.

import type { InboundMessage, SessionState } from "./types.js";

export interface QueueDecision {
  action: "prompt" | "steer" | "followUp";
  text: string;
}

export function decide(
  msg: Pick<InboundMessage, "text" | "mode">,
  state: SessionState,
): QueueDecision {
  const steerPrefixed = msg.text.startsWith("!");
  const text = steerPrefixed ? msg.text.slice(1).trimStart() : msg.text;
  if (state === "idle") return { action: "prompt", text };
  if (msg.mode === "steer" || msg.mode === "followUp") {
    return { action: msg.mode, text };
  }
  return { action: steerPrefixed ? "steer" : "followUp", text };
}
