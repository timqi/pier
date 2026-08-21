// The composer: input + drafts, pending image strip, send semantics, and the
// pending queue panel. Owns the optimistic user-turn ledger that main.ts
// reconciles against `user-message` events.

import { $, h } from "./dom.js";
import { appendTurn, imageThumb, scrollBottom, turnsPane } from "./chat.js";
import type { ImageAttachment, SessionState } from "../../core/types.js";

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
let pendingImages: ImageAttachment[] = [];
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
      const li = h("li", "flex h-6 items-center gap-2 text-[13px]");
      // Only "steer" earns a badge: it deviates from the panel's own label,
      // which already says these messages are queued.
      if (r.mode === "steer") {
        li.append(
          h(
            "span",
            "flex-none rounded bg-indigo-100 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700",
            r.mode,
          ),
        );
      }
      li.append(h("span", "truncate text-neutral-700", r.text));
      return li;
    }),
  );
}

// --- pending image strip ---------------------------------------------------------

function renderImageStrip(): void {
  imageStrip.classList.toggle("hidden", pendingImages.length === 0);
  imageStrip.classList.toggle("flex", pendingImages.length > 0);
  imageStrip.replaceChildren(
    ...pendingImages.map((img, i) => {
      const wrap = h("div", "relative");
      const thumb = document.createElement("img");
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      thumb.className = "h-16 w-16 rounded-md border border-neutral-200 object-cover";
      const remove = h(
        "button",
        "absolute -right-1.5 -top-1.5 h-4 w-4 cursor-pointer rounded-full bg-neutral-700 text-[10px] leading-none text-white hover:bg-red-600",
        "×",
      );
      remove.onclick = () => {
        pendingImages.splice(i, 1);
        renderImageStrip();
      };
      wrap.append(thumb, remove);
      return wrap;
    }),
  );
}

function addImageFile(file: File): void {
  if (!file.type.startsWith("image/") || pendingImages.length >= 8) return;
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result as string;
    pendingImages.push({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type });
    renderImageStrip();
  };
  reader.readAsDataURL(file);
}

/** Mirrors the agent seam's user-message text so reconcile can match on it. */
const imageMarker = (text: string, images: number): string =>
  images ? `${text}${text ? " " : ""}[${images} image${images > 1 ? "s" : ""}]` : text;

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
  pendingImages = [];
  renderImageStrip();
}

/** Single-line by default; grows with content, icons stay on the bottom row. */
function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 192)}px`; // cap = max-h-48
}

// --- sending ---------------------------------------------------------------------------

/** `label` sends that text instead of the composer's — a next-step button
 *  click is a side action and must not consume the user's unsent draft. */
export async function send(mode: "auto" | "steer", label?: string): Promise<void> {
  const text = (label ?? input.value).trim();
  const images = label === undefined ? pendingImages : [];
  const id = deps.sessionId();
  if ((!text && images.length === 0) || !id) return;
  const startsTurn = deps.sessionState() === "idle" && mode === "auto";
  if (label === undefined) {
    input.value = "";
    autosize();
    saveDraft(); // sent text is no longer a draft
    pendingImages = [];
    renderImageStrip();
  }
  if (startsTurn) deps.setState("streaming");
  else updateComposer();
  // Optimistic: a fresh prompt (or a steer) reads as a user turn; only a
  // message sent into an existing run waits for the queue-state snapshot.
  if (startsTurn || mode === "steer") {
    optimisticUserTexts.push(imageMarker(text, images.length));
    const bubble = appendTurn("user", text);
    for (const img of images) bubble.append(imageThumb(`data:${img.mimeType};base64,${img.data}`));
    scrollBottom(true);
  }
  const res = await fetch(`/api/sessions/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode, images: images.length ? images : undefined }),
  });
  if (!res.ok) {
    appendTurn("error", `send failed: ${res.status}`);
    await deps.reload(id);
  }
}

/** Promote the queue: steer into the running turn, or abort it and re-prompt. */
async function deliverQueue(mode: "steer" | "restart"): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  renderQueue([], []); // optimistic; queue-state snapshots reconcile
  const res = await fetch(`/api/sessions/${id}/queue/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
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
  stopBtn.onclick = () => {
    const id = deps.sessionId();
    if (id) void fetch(`/api/sessions/${id}/abort`, { method: "POST" });
  };
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
  input.onkeydown = (ev) => {
    // IME guard: Enter that confirms a composition candidate must not send
    // (isComposing covers modern browsers; 229 covers stragglers).
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send("auto");
    }
  };
  // Paste / drop / picker → pending image strip. Pasted text is trimmed: copied
  // snippets drag along leading/trailing blank lines nobody wants in a prompt.
  input.onpaste = (ev) => {
    for (const item of ev.clipboardData?.items ?? []) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) addImageFile(file);
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
    for (const file of ev.dataTransfer?.files ?? []) addImageFile(file);
  };
  $("#attach").onclick = () => attachInput.click();
  attachInput.onchange = () => {
    for (const file of attachInput.files ?? []) addImageFile(file);
    attachInput.value = "";
  };
  updateComposer();
}
