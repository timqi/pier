// What the shared control moments say — one spelling for both platforms. The
// only legitimate variations are platform spellings (the bind command, a label's
// emphasis), so they are the parameters.

import { originLabel, runModelLabel } from "../core/reply.js";
import type { NoteOrigin } from "../core/types.js";
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

/** What a chat window gets of a system input; a task callback carries up to
 *  8000 characters of result text (tasks/callbacks.ts). */
const NOTE_CHARS = 200;
const NOTE_LINES = 4;

function digest(text: string): string {
  const body = text.trimEnd();
  let head = body.split("\n").slice(0, NOTE_LINES).join("\n");
  if (head.length > NOTE_CHARS) {
    const capped = head.slice(0, NOTE_CHARS);
    // A boundary before the midpoint loses more than the ragged edge costs.
    const boundary = Math.max(capped.lastIndexOf("\n"), capped.lastIndexOf(" "));
    head = capped.slice(0, boundary > NOTE_CHARS / 2 ? boundary : NOTE_CHARS);
  }
  const rest = body.slice(head.length).trim();
  if (!rest) return body;
  const dropped = rest.split("\n").length;
  return `${head.trimEnd()}\n… +${String(dropped)} more line${dropped === 1 ? "" : "s"}`;
}

/** The origin label in the platform's `emphasis` over the quoted body. A system
 *  input is context for the turn it precedes: pasted whole, a run result buries
 *  a chat that cannot collapse it, so it is digested (the hub keeps it all). An
 *  error is quoted whole, core already capped it; so is a chat command's
 *  answer, bounded and the reason it was asked. */
export function noteBody(note: { text: string; origin: NoteOrigin }, emphasis: string): string {
  const whole = note.origin.kind === "error" || note.origin.kind === "chat-command";
  const text = whole ? note.text : digest(note.text);
  const body = text.split("\n").map((line) => `> ${line}`).join("\n");
  // The run's model is a detail of the label, so it sits outside the emphasis.
  const source = note.origin.kind === "task-callback" || note.origin.kind === "task-delegation" ? note.origin.source : undefined;
  const model = source ? runModelLabel(source) : "";
  return `${emphasis}${originLabel(note.origin)}${emphasis}${model ? ` ${model}` : ""}\n${body}`;
}
