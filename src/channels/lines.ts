// What the shared control moments say — one spelling for three platforms.
//
// Bind, stop and the option echo behave identically everywhere by contract,
// and their lines were copied per adapter until Lark made three of each; the
// same wording drifting apart is how the panels went (see panel.ts). How a
// line is *sent* stays with the adapter; the only legitimate variation is the
// spelling of the bind command, so it is the parameter.

/** DM-only, throttled by Gatekeeper.mayHint; groups stay silent by contract. */
export const bindHint = (command: string): string =>
  `You are not bound yet. Ask the operator for a bind code, then send ${command}.`;

/** The answer to a bind attempt. The name arrives escaped by the caller. */
export const bindResult = (ok: boolean, name: string): string =>
  ok ? `Bound as ${name}.` : "That bind code is invalid or expired.";

/** Acknowledges /stop; the turn's own end still arrives through send(). */
export const STOPPED = "\u23f9 Stopped.";

/** A picked option, echoed because a bot cannot post as the user. */
export const picked = (label: string): string => `\u25b8 ${label}`;

/** A click on options that are gone — retired, or from before this process'
 *  conventions. Said in the chat: the person clicked and would otherwise see
 *  nothing happen, which reads as broken (5b). */
export const STALE_OPTION =
  "⚠ That option is no longer available — please type the choice instead.";
