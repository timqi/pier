// What the shared control moments say — one spelling for three platforms. The
// only legitimate variation is the spelling of the bind command, so it is the parameter.

export const bindHint = (command: string): string =>
  `You are not bound yet. Ask the operator for a bind code, then send ${command}.`;

/** The name arrives escaped by the caller. */
export const bindResult = (ok: boolean, name: string): string =>
  ok ? `Bound as ${name}.` : "That bind code is invalid or expired.";

export const STOPPED = "\u23f9 Stopped.";

/** Echoed because a bot cannot post as the user. */
export const picked = (label: string): string => `\u25b8 ${label}`;

/** Said in the chat: the person clicked and would otherwise see nothing happen (§5b). */
export const STALE_OPTION =
  "⚠ That option is no longer available — please type the choice instead.";
