// Voice mode: the composer's hold-to-talk bar, what a press on it does, and
// the caption card a take shows over the transcript (03-web-workbench.md
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
}

const MODE_KEY = "pier.voice";
const LIMIT_S = 300; // the server's cap on a take
const WARN_S = 30;
const LINE_PX = 30; // the card's 20px text at 1.5

const composer = $("#composer");
const input = $<HTMLTextAreaElement>("#input");
const toggle = $<HTMLButtonElement>("#voice");
const bar = $<HTMLButtonElement>("#voice-hold");
const barLabel = $("#voice-hold-label");
const layer = $("#voice-layer");
const card = $("#voice-card");
const status = $("#voice-status");
const clock = $("#voice-clock");
const caption = $("#voice-text");
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

/** Voice mode is on: the draft is not focused for the user, only on their tap. */
export const voiceMode = (): boolean => voiceOn;

function setMode(on: boolean, focus = true): void {
  voiceOn = on;
  composer.toggleAttribute("data-voice", on);
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Keyboard" : "Voice input";
  toggle.setAttribute("aria-label", toggle.title);
  $("#voice-mic").hidden = on;
  $("#voice-keyboard").hidden = !on;
  if (on) localStorage.setItem(MODE_KEY, "on");
  else localStorage.removeItem(MODE_KEY);
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
  layer.hidden = !open;
  card.toggleAttribute("data-cancel", cancelling);
  card.dataset.state = state;
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

/** The take's own text, from the draft: settled, then the partial. Follows the
 *  end only when the reader was there already, so scrolling up stops it. */
function paintCaption(): void {
  const atEnd = caption.scrollHeight - caption.scrollTop - caption.clientHeight <= LINE_PX;
  const settled = span ? input.value.slice(span.start, span.mid) : "";
  const partial = span ? input.value.slice(span.mid, span.end) : "";
  caption.replaceChildren(
    ...(settled || partial
      ? [settled.trimStart(), h("span", "text-neutral-500", settled ? partial : partial.trimStart())]
      : [h("span", "text-neutral-400", "Speak now")]),
  );
  if (atEnd) caption.scrollTop = caption.scrollHeight;
}

function write(edit: (span: Span) => SpanEdit): void {
  if (!span) return;
  const e = edit(span);
  const [from, to] = [caretAfter(e, input.selectionStart), caretAfter(e, input.selectionEnd)];
  input.setRangeText(e.text, e.from, e.to);
  input.setSelectionRange(from, to);
  span = e.span;
  deps.changed(takeSession);
  // The draft is not focused, so nothing scrolls it to the take's end but this.
  const end = e.from + e.text.length;
  if (input.value) input.scrollTop = Math.max(0, (input.scrollHeight * end) / input.value.length - input.clientHeight);
  paintCaption();
}

function onEvent(e: VoiceEvent): void {
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
  }
  input.readOnly = next !== "idle";
  // A focus left inside the hidden card would fall to the page.
  if (!live() && card.contains(document.activeElement)) bar.focus();
  paint();
}

function begin(): void {
  takeSession = deps.sessionId();
  span = spanAt(input.selectionEnd);
  started = Date.now();
  paintClock();
  ticker = setInterval(paintClock, 1000);
  caption.scrollTop = 0;
  paintCaption();
  try {
    take = startTake({ onEvent, onState });
  } catch (err) {
    onState("idle");
    appendTurn("error", `voice input: ${String(err)}`);
  }
}

/** The text stays, the card closes; the bar is `Finishing…` until `done`. */
function finish(): void {
  take?.stop();
}

export function cancelVoice(): void {
  if (!take) return;
  write(spanCancel);
  take.cancel();
}

/** The draft went out of sight, to another session unasked, or was sent: the
 *  take ends with its text kept, and writes no more. */
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
  layer.addEventListener("click", (ev) => {
    if (ev.target !== layer || press) return;
    finish();
    bar.focus();
  });
  cancelBtn.onclick = () => {
    cancelVoice();
    bar.focus();
  };
}

/** Shown only where the server can transcribe and the browser can capture. */
async function offerVoice(): Promise<void> {
  if (!(await voiceAvailable())) return;
  toggle.hidden = false;
  toggle.onclick = () => setMode(!voiceOn);
  setMode(localStorage.getItem(MODE_KEY) === "on", false);
  wireBar();
  window.addEventListener("pagehide", cancelVoice);
  // A tap on the draft is to edit it: the keyboard, the caret where it landed.
  // During a take the draft is read-only and stays unfocused, so a later tap is
  // still the one that leaves voice mode.
  input.addEventListener("focus", () => {
    if (!voiceOn) return;
    if (state === "idle") setMode(false, false);
    else input.blur();
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
