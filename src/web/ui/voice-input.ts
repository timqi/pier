// Voice mode: the composer's hold-to-talk bar, what a press on it does, and
// the panel the composer card becomes while a take runs (03-web-workbench.md
// §Voice input). One take at a time (voice.ts); its text is a span of the
// draft, which is read-only while the take runs.

import { $, h } from "./dom.js";
import { appendTurn } from "./chat.js";
import { escapeKey } from "./shortcut.js";
import { caretAfter, type Press, pressAt, type Span, type SpanEdit, spanAt, spanCancel, spanError, spanText, startTake, type Take, type TakeState, type VoiceEvent, voiceAvailable } from "./voice.js";

interface VoiceDeps {
  sessionId: () => string | null;
  chatVisible: () => boolean;
  /** The draft of session `id` changed under the take: resize and save it. */
  changed: (id: string | null) => void;
  /** The draft's box changed its type or minimum: measure its height again. */
  resize: () => void;
}

const MODE_KEY = "pier.voice";
const LIMIT_S = 300; // the server's cap on a take
const WARN_S = 30;
const LINE_PX = 30; // the panel's 20px text at 1.5

const composer = $("#composer");
const input = $<HTMLTextAreaElement>("#input");
const toggle = $<HTMLButtonElement>("#voice");
const bar = $<HTMLButtonElement>("#voice-hold");
const barLabel = $("#voice-hold-label");
const head = $("#voice-head");
const status = $("#voice-status");
const clock = $("#voice-clock");
const hint = $("#voice-hint");
const cancelBtn = $("#voice-cancel");

let deps: VoiceDeps;
let voiceOn = false;
let take: Take | null = null;
let state: TakeState = "idle";
let takeSession: string | null = null;
let span: Span | null = null;
// The pointer holding the take, until it lets go or the take turns hands-free.
let press: (Press & { id: number }) | null = null;
let cancelling = false;
let started = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let clean = false; // the take ended with `done`: its text is whole
let settling: ((whole: boolean) => void)[] = [];

/** Voice mode is on: the draft is focused only by the user's tap. */
export const voiceMode = (): boolean => voiceOn;

/** `remember` false: not the user's switch, so the stored mode stays for later. */
function setMode(on: boolean, focus = true, remember = true): void {
  voiceOn = on;
  composer.toggleAttribute("data-voice", on);
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Keyboard" : "Voice input";
  toggle.setAttribute("aria-label", toggle.title);
  $("#voice-mic").hidden = on;
  $("#voice-keyboard").hidden = !on;
  if (remember && on) localStorage.setItem(MODE_KEY, "on");
  else if (remember) localStorage.removeItem(MODE_KEY);
  deps.resize();
  // The phone's keyboard follows the focus: down for talking, up for typing.
  if (on) input.blur();
  else if (focus) input.focus();
}

/** The draft takes the keyboard, leaving voice mode if it was on. */
export function keyboardMode(): void {
  if (state !== "idle") return;
  if (voiceOn) setMode(false);
  else input.focus();
}

const live = (): boolean => state === "starting" || state === "recording";

function paint(): void {
  const open = live();
  if (open) composer.dataset.take = state;
  else delete composer.dataset.take;
  composer.toggleAttribute("data-cancel", cancelling);
  input.placeholder = open ? "Speak now" : "Message…";
  status.textContent = cancelling ? "Release to cancel" : state === "starting" ? "Starting…" : "Listening";
  hint.hidden = !press;
  hint.textContent = cancelling ? "Slide back to keep talking" : "Release to finish · slide up to cancel";
  const handsFree = open && !press;
  // Not `disabled`: that would drop the focus the bar holds for the keyboard.
  bar.setAttribute("aria-disabled", String(state === "finishing"));
  bar.toggleAttribute("data-live", open);
  barLabel.textContent = state === "finishing" ? "Finishing…" : handsFree ? "Tap to finish" : "Hold to talk";
  $("#voice-hold-mic").hidden = handsFree;
  $("#voice-hold-stop").hidden = !handsFree;
  toggle.disabled = state !== "idle";
}

function paintClock(): void {
  const s = Math.floor((Date.now() - started) / 1000);
  const left = LIMIT_S - s;
  const warn = left <= WARN_S;
  const shown = warn ? Math.max(0, left) : s;
  clock.textContent = `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, "0")}${warn ? " left" : ""}`;
  clock.classList.toggle("text-amber-700", warn);
  clock.classList.toggle("text-neutral-500", !warn);
}

function write(edit: (span: Span) => SpanEdit): void {
  if (!span) return;
  const follow = atTakeEnd(span.end);
  const e = edit(span);
  const [from, to] = [caretAfter(e, input.selectionStart), caretAfter(e, input.selectionEnd)];
  input.setRangeText(e.text, e.from, e.to);
  input.setSelectionRange(from, to);
  span = e.span;
  deps.changed(takeSession);
  if (follow) reveal(e.from + e.text.length);
}

/** The take's end is within a line of the draft's view: a reader who scrolled
 *  it away stops the following, and scrolling back resumes it. */
function atTakeEnd(end: number): boolean {
  if (input.scrollHeight <= input.clientHeight) return true;
  const y = heightTo(end);
  return y >= input.scrollTop - LINE_PX && y <= input.scrollTop + input.clientHeight + LINE_PX;
}

/** The draft is not focused, so nothing scrolls it to the take's end but this. */
function reveal(end: number): void {
  if (input.scrollHeight > input.clientHeight) input.scrollTop = Math.max(0, heightTo(end) - input.clientHeight);
}

/** How tall the draft is down to `end`, laid out in a copy of its own box. */
function heightTo(end: number): number {
  if (end === input.value.length) return input.scrollHeight;
  const style = getComputedStyle(input);
  const mirror = h("div", "");
  mirror.style.cssText = "position:absolute;visibility:hidden;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word";
  mirror.style.width = `${input.clientWidth}px`;
  for (const prop of ["font", "lineHeight", "letterSpacing", "padding"] as const) mirror.style[prop] = style[prop];
  // A last line that is empty has no height without a character on it.
  mirror.textContent = `${input.value.slice(0, end)}\u200b`;
  document.body.append(mirror);
  const height = mirror.offsetHeight;
  mirror.remove();
  return height;
}

function onEvent(e: VoiceEvent): void {
  if (e.type === "done") clean = true;
  if (e.type === "partial" || e.type === "final") write((s) => spanText(s, e.type, e.text, input.value[s.mid - 1]));
  if (e.type !== "error") return;
  write(spanError);
  appendTurn("error", `voice input: ${e.message}`);
}

function onState(next: TakeState): void {
  state = next;
  if (next === "idle") {
    take = null;
    span = null;
    // Ended under the finger (Esc, Send, an error): its later moves are no take's.
    if (press && bar.hasPointerCapture(press.id)) bar.releasePointerCapture(press.id);
    press = null;
    cancelling = false;
    clearInterval(ticker);
    for (const settle of settling.splice(0)) settle(clean);
    clean = false;
  }
  input.readOnly = next !== "idle";
  // A focus left inside the hidden head would fall to the page.
  if (!live() && head.contains(document.activeElement)) bar.focus();
  paint();
  deps.resize();
}

function begin(): void {
  takeSession = deps.sessionId();
  span = spanAt(input.selectionEnd);
  started = Date.now();
  paintClock();
  ticker = setInterval(paintClock, 1000);
  input.blur();
  try {
    take = startTake({ onEvent, onState });
    if (span) reveal(span.end);
  } catch (err) {
    onState("idle");
    appendTurn("error", `voice input: ${String(err)}`);
  }
}

/** The text stays, the head closes; the bar is `Finishing…` until `done`. */
function finish(): void {
  take?.stop();
}

export function cancelVoice(): void {
  if (!take) return;
  write(spanCancel);
  take.cancel();
}

/** A take is running or finishing: the draft is not whole yet. */
export const voiceBusy = (): boolean => take !== null;

/** Ends the take as a release does; true once `done` left its text whole in
 *  the draft, false when it was cancelled or failed instead. */
export function settleVoice(): Promise<boolean> {
  finish();
  return new Promise((resolve) => settling.push(resolve));
}

/** The draft went out of sight, or to another session unasked: the take ends
 *  with its text kept, and writes no more. */
export function endVoice(): void {
  span = null;
  take?.cancel();
}

function track(ev: PointerEvent, type: "move" | "up" | "cancel"): void {
  if (!press || ev.pointerId !== press.id) return;
  const next = pressAt(press, type, ev.clientX, ev.clientY, ev.timeStamp);
  if (type === "move") {
    if ((next === "cancelling") === cancelling) return;
    cancelling = !cancelling;
    return paint();
  }
  take?.resume();
  press = null;
  cancelling = false;
  if (next === "cancel") cancelVoice();
  else if (next === "finish") finish();
  else {
    bar.focus();
    paint();
  }
}

function wireBar(): void {
  bar.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || press || state === "finishing") return;
    // Hands-free: the next press on the bar is the tap that finishes.
    if (state !== "idle") return finish();
    bar.setPointerCapture(ev.pointerId);
    press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, at: ev.timeStamp, top: bar.getBoundingClientRect().top };
    begin();
  });
  bar.addEventListener("pointermove", (ev) => track(ev, "move"));
  bar.addEventListener("pointerup", (ev) => track(ev, "up"));
  bar.addEventListener("pointercancel", (ev) => track(ev, "cancel"));
  // A long press is the take, not the system's selection or menu.
  bar.addEventListener("contextmenu", (ev) => ev.preventDefault());
  bar.addEventListener("keydown", (ev) => {
    if ((ev.key !== "Enter" && ev.key !== " ") || ev.repeat) return;
    ev.preventDefault();
    if (state === "idle") begin();
    else if (live() && !press) finish();
  });
  cancelBtn.onclick = () => {
    cancelVoice();
    bar.focus();
  };
}

let wired = false;

/** Shown only where the server can transcribe and the browser can capture;
 *  asked again when the Console switches the recognizer. */
export async function offerVoice(): Promise<void> {
  const available = await voiceAvailable();
  toggle.hidden = !available;
  if (!available) {
    cancelVoice();
    // Not the user's switch: the remembered mode returns with the recognizer.
    setMode(false, false, false);
    return;
  }
  setMode(localStorage.getItem(MODE_KEY) === "on", false);
  if (wired) return;
  wired = true;
  toggle.onclick = () => setMode(!voiceOn);
  wireBar();
  window.addEventListener("pagehide", cancelVoice);
  // A tap on the draft between takes edits it in voice mode; during a take it
  // is read-only, and the focus stays on the bar that finishes hands-free.
  input.addEventListener("focus", () => {
    if (state !== "idle") bar.focus();
  });
}

/** Before the turn's own Esc: a take running is the nearer thing to cancel. */
export function initVoice(d: VoiceDeps): void {
  deps = d;
  escapeKey(cancelBtn, "Cancel voice input", () => {
    cancelVoice();
    bar.focus();
  }, () => live() && deps.chatVisible());
  void offerVoice();
}
