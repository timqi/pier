// What the shared control moments say — one spelling for three platforms. The
// only legitimate variation is the spelling of the bind command, so it is the parameter.

import type { BindOutcome } from "./types.js";

export const bindHint = (command: string): string =>
  `You are not bound yet. Ask the operator for a bind code, then send ${command}.`;

/** The name arrives escaped by the caller. */
export const bindResult = (outcome: BindOutcome, name: string): string => {
  if (outcome === "bound") return `Bound as ${name}.`;
  return outcome === "voided"
    ? "That bind code is invalid or expired — and too many wrong tries have now" +
      " voided it. Ask the operator for a new one."
    : "That bind code is invalid or expired.";
};

export const STOPPED = "\u23f9 Stopped.";

/** Echoed because a bot cannot post as the user. */
export const picked = (label: string): string => `\u25b8 ${label}`;

/** Said in the chat: the person clicked and would otherwise see nothing happen (§5). */
export const STALE_OPTION =
  "⚠ That option is no longer available — please type the choice instead.";
