// The composer: input + drafts, pending attachment strip, send semantics, and
// the pending queue panel. Owns the optimistic user-turn ledger that main.ts
// reconciles against `user-message` events.

import { failure, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { appendTurn, scrollBottom, turnsPane } from "./chat.js";
import { fileMarker, MAX_INBOUND_BYTES } from "../../core/inbound-file.js";
import { escapeKey } from "./shortcut.js";
import type { SessionState } from "../../core/types.js";

/** A file picked but not yet sent; uploaded to the inbox on send. */
interface PendingFile {
  data: string; // base64
  mimeType: string;
  name?: string; // absent for a pasted screenshot — the server derives one
}

/** Everything the composer needs from the orchestrator (main.ts). */
export interface ComposerDeps {
  sessionId: () => string | null;
  sessionState: () => SessionState;
  chatVisible: () => boolean;
  setState: (state: SessionState) => void;
  /** Reload the session snapshot if `id` is still the selected session. */
  reload: (id: string) => Promise<void>;
}

let deps: ComposerDeps;

const composer = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendBtn = $("#send");
const sendPlane = $("#send-plane");
const sendQueue = $("#send-queue");
const stopBtn = $("#stop");
const queuePanel = $("#queue-panel");
const queueRows = $("#queue-rows");
const queueLabel = $("#queue-label");
const imageStrip = $("#image-strip");
const attachInput = $<HTMLInputElement>("#attach-input");

let queueHasRows = false;
let pendingFiles: PendingFile[] = [];
// Texts already rendered optimistically, awaiting their user-message event so
// the same turn isn't drawn twice.
let optimisticUserTexts: string[] = [];

export function focusInput(): void {
  input.focus();
}

/** True when `text` was our own optimistic render — the caller skips drawing it. */
export function reconcileOptimisticUser(text: string): boolean {
  const i = optimisticUserTexts.indexOf(text);
  if (i < 0) return false;
  optimisticUserTexts.splice(i, 1);
  return true;
}

/** Record a turn this client already drew, so its event only reconciles. */
export function markOptimisticUser(text: string): void {
  optimisticUserTexts.push(text);
}

export function clearOptimistic(): void {
  optimisticUserTexts = [];
}

/** The composer buttons ARE the state display: indigo plane when idle
 *  (send starts a turn), amber clock + red stop while streaming (send
 *  queues; the queue panel offers Send now / Abort & send). */
export function updateComposer(): void {
  const streaming = deps.sessionState() === "streaming";
  sendBtn.className = `flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg ${
    streaming
      ? "bg-amber-100 text-amber-700 hover:bg-amber-200 active:bg-amber-300"
      : "bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700"
  }`;
  sendBtn.title = streaming ? "Queue — delivered when the turn ends" : "Send";
  sendPlane.classList.toggle("hidden", streaming);
  sendQueue.classList.toggle("hidden", !streaming);
  stopBtn.classList.toggle("hidden", !streaming);
  stopBtn.classList.toggle("flex", streaming);
}

// --- pending queue panel (avibe ChatQueueRow concept) -----------------------

export function syncQueuePanel(): void {
  const visible = deps.chatVisible() && queueHasRows;
  queuePanel.classList.toggle("hidden", !visible);
  queuePanel.classList.toggle("flex", visible);
}

export function renderQueue(steering: string[], followUp: string[]): void {
  const rows = [
    ...steering.map((text) => ({ mode: "steer", text })),
    ...followUp.map((text) => ({ mode: "queued", text })),
  ];
  queueHasRows = rows.length > 0;
  // The count sits on the label so the header actions read as queue-wide.
  queueLabel.textContent = rows.length > 1 ? `Queued · ${rows.length}` : "Queued";
  syncQueuePanel();
  queueRows.replaceChildren(
    ...rows.map((r) => {
      // A queued message keeps the shape it was typed in — the composer takes
      // multi-line input, so the row wraps and grows instead of truncating; the
      // list scrolls past ~5 lines (see #queue-rows) so the panel can't push
      // the composer off screen.
      const li = h("li", "flex items-start gap-2 text-[13px] leading-[18px]");
      // Only "steer" earns a badge: it deviates from the panel's own label,
      // which already says these messages are queued.
      if (r.mode === "steer") {
        li.append(h("span", "flex-none rounded bg-indigo-100 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700", r.mode));
      }
      li.append(h("span", "min-w-0 whitespace-pre-wrap break-words text-neutral-700", r.text));
      return li;
    }),
  );
}

// --- pending attachment strip ------------------------------------------------------

const MAX_FILES = 8;

function renderFileStrip(): void {
  imageStrip.classList.toggle("hidden", pendingFiles.length === 0);
  imageStrip.classList.toggle("flex", pendingFiles.length > 0);
  imageStrip.replaceChildren(
    ...pendingFiles.map((f, i) => {
      const body = f.mimeType.startsWith("image/")
        ? Object.assign(document.createElement("img"), {
            src: `data:${f.mimeType};base64,${f.data}`,
            className: "h-16 w-16 rounded-md border border-neutral-200 object-cover",
          })
        : h("span", "flex h-16 max-w-40 items-center truncate rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[12px] text-neutral-700", f.name ?? "file");
      const remove = h("button", "absolute -right-1.5 -top-1.5 h-4 w-4 cursor-pointer rounded-full bg-neutral-700 text-[10px] leading-none text-white hover:bg-red-600", "×");
      remove.onclick = () => {
        pendingFiles.splice(i, 1);
        renderFileStrip();
      };
      return h("div", "relative", body, remove);
    }),
  );
}

function addFile(file: File): void {
  // A refused file says so (5b) — a picker that swallows picks reads as broken.
  if (pendingFiles.length >= MAX_FILES) {
    appendTurn("error", `attachment limit is ${MAX_FILES} files per message`);
    return;
  }
  if (file.size > MAX_INBOUND_BYTES) {
    appendTurn("error", `${file.name || "file"} is too large (32MB max)`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result as string;
    pendingFiles.push({
      data: url.slice(url.indexOf(",") + 1),
      mimeType: file.type || "application/octet-stream",
      name: file.name || undefined,
    });
    renderFileStrip();
  };
  reader.readAsDataURL(file);
}

/**
 * Upload files to the inbox and return their marker lines — built with the
 * shared grammar (core/inbound-file.ts), so the text we send and render
 * optimistically is exactly the text every other surface will see.
 */
async function uploadFiles(files: PendingFile[]): Promise<string[] | null> {
  const markers: string[] = [];
  for (const f of files) {
    const res = await sendJson("/api/inbox", f);
    if (!res.ok) return null;
    const { path } = (await res.json()) as { path: string };
    markers.push(fileMarker(path));
  }
  return markers;
}

// --- composer drafts -------------------------------------------------------------------
// One draft per session, in localStorage only: switching sessions must not
// carry text (or attachments) into the wrong conversation, and an unsent draft
// is the client's business, never the agent's.

const draftKey = (id: string): string => `pier.draft.${id}`;

export function saveDraft(): void {
  const id = deps.sessionId();
  if (!id) return;
  if (input.value.trim()) localStorage.setItem(draftKey(id), input.value);
  else localStorage.removeItem(draftKey(id));
}

export function restoreDraft(id: string): void {
  input.value = localStorage.getItem(draftKey(id)) ?? "";
  autosize();
  pendingFiles = [];
  renderFileStrip();
}

/** Single-line by default; grows with content, icons stay on the bottom row. */
function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 192)}px`; // cap = max-h-48
}

// --- sending ---------------------------------------------------------------------------

let sending = false; // uploads await; a second Enter meanwhile must not double-send

/** `label` sends that text instead of the composer's — a next-step button
 *  click is a side action and must not consume the user's unsent draft. */
export async function send(mode: "auto" | "steer", label?: string): Promise<void> {
  const typed = (label ?? input.value).trim();
  const files = label === undefined ? pendingFiles : [];
  const id = deps.sessionId();
  if ((!typed && files.length === 0) || !id) return;
  if (label === undefined) {
    if (sending) return;
    sending = true;
    // Cleared before any await: whatever is typed while an upload runs is a
    // new draft, not collateral of this send.
    input.value = "";
    autosize();
    saveDraft();
    pendingFiles = [];
    renderFileStrip();
  }
  try {
    // Files first: their markers are part of the message text, so the upload
    // must land before the text exists.
    let markers: string[] = [];
    if (files.length) {
      const uploaded = await uploadFiles(files);
      if (uploaded === null) {
        appendTurn("error", "attachment upload failed");
        // Give the message back — merged with anything typed meanwhile.
        input.value = [typed, input.value.trim()].filter(Boolean).join("\n");
        autosize();
        saveDraft();
        pendingFiles = files;
        renderFileStrip();
        return;
      }
      markers = uploaded;
    }
    const text = [typed, ...markers].filter(Boolean).join("\n");
    const startsTurn = deps.sessionState() === "idle" && mode === "auto";
    if (startsTurn) deps.setState("streaming");
    else updateComposer();
    // Optimistic: a fresh prompt (or a steer) reads as a user turn; only a
    // message sent into an existing run waits for the queue-state snapshot.
    // appendTurn renders the marker lines as attachment thumbs/cards itself.
    if (startsTurn || mode === "steer") {
      markOptimisticUser(text);
      appendTurn("user", text);
      scrollBottom(true);
    }
    const res = await sendJson(`/api/sessions/${id}/messages`, { text, mode });
    if (!res.ok) {
      // The body names the cause when there is one — a draining restart, say.
      // After the reload, which wipes the pane an error row would go into.
      const why = await failure(res, "send failed");
      await deps.reload(id);
      appendTurn("error", why);
    }
  } finally {
    if (label === undefined) sending = false;
  }
}

/** Promote the queue: steer into the running turn, or abort it and re-prompt. */
async function deliverQueue(mode: "steer" | "restart"): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  renderQueue([], []); // optimistic; queue-state snapshots reconcile
  const res = await sendJson(`/api/sessions/${id}/queue/deliver`, { mode });
  if (!res.ok) appendTurn("error", `queue ${mode} failed: ${res.status}`);
}

async function recallQueue(): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  const res = await fetch(`/api/sessions/${id}/queue/recall`, { method: "POST" });
  if (!res.ok) return;
  const { messages } = (await res.json()) as { messages: string[] };
  // Append (not replace) so an existing draft isn't clobbered — avibe recall rule.
  if (messages.length) {
    input.value = [input.value.trim(), ...messages].filter(Boolean).join("\n");
    autosize();
    saveDraft();
    input.focus();
  }
  renderQueue([], []);
}

// --- wiring ----------------------------------------------------------------------------

export function initComposer(d: ComposerDeps): void {
  deps = d;
  const abort = (): void => {
    const id = deps.sessionId();
    if (id) void fetch(`/api/sessions/${id}/abort`, { method: "POST" });
  };
  stopBtn.onclick = abort;
  // Only while the button is on screen: Esc with nothing running belongs to
  // the browser, and in a Console view there is no turn in front of you.
  escapeKey(stopBtn, "Stop the running turn", abort, () =>
    deps.sessionState() === "streaming" && deps.chatVisible());
  $("#queue-steer").onclick = () => void deliverQueue("steer");
  $("#queue-restart").onclick = () => void deliverQueue("restart");
  $("#queue-recall").onclick = () => void recallQueue();
  composer.onsubmit = (ev) => {
    ev.preventDefault();
    void send("auto");
  };
  input.oninput = () => {
    autosize();
    saveDraft();
  };
  // A touch keyboard's Enter is the only way to get a newline (there is no
  // Shift), so there it types one and the send button is the only send.
  const enterSends = !matchMedia("(pointer: coarse)").matches;
  input.onkeydown = (ev) => {
    // IME guard: Enter that confirms a composition candidate must not send
    // (isComposing covers modern browsers; 229 covers stragglers).
    if (ev.isComposing || ev.keyCode === 229) return;
    if (enterSends && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send("auto");
    }
  };
  // Paste / drop / picker → pending attachment strip. Pasted text is trimmed:
  // copied snippets drag along blank lines nobody wants in a prompt.
  input.onpaste = (ev) => {
    for (const item of ev.clipboardData?.items ?? []) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) addFile(file);
    }
    const pasted = ev.clipboardData?.getData("text/plain") ?? "";
    const trimmed = pasted.trim();
    if (!trimmed || trimmed === pasted) return; // nothing to fix — native paste
    ev.preventDefault();
    input.setRangeText(trimmed, input.selectionStart ?? 0, input.selectionEnd ?? 0, "end");
    autosize();
    saveDraft();
  };
  turnsPane.ondragover = (ev) => ev.preventDefault();
  turnsPane.ondrop = (ev) => {
    ev.preventDefault();
    for (const file of ev.dataTransfer?.files ?? []) addFile(file);
  };
  $("#attach").onclick = () => attachInput.click();
  attachInput.onchange = () => {
    for (const file of attachInput.files ?? []) addFile(file);
    attachInput.value = "";
  };
  updateComposer();
}
