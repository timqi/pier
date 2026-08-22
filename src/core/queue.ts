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
  // An explicit mode takes the text verbatim: IM sends steer for every
  // message, so a leading "!" there is content, not a control prefix —
  // consuming it silently rewrote what the person typed.
  if (msg.mode === "steer" || msg.mode === "followUp") {
    return { action: state === "idle" ? "prompt" : msg.mode, text: msg.text };
  }
  // On auto the "!" is a control prefix and always consumed — whether the
  // turn happened to end first must not decide if it was content. Idle just
  // means there is nothing to steer, so it degenerates to a prompt.
  const steerPrefixed = msg.text.startsWith("!");
  const text = steerPrefixed ? msg.text.slice(1).trimStart() : msg.text;
  if (state === "idle") return { action: "prompt", text };
  return { action: steerPrefixed ? "steer" : "followUp", text };
}
