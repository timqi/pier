// The composer: input + drafts, pending attachment strip, send semantics, and
// the pending queue panel. Owns the optimistic user-turn ledger that main.ts
// reconciles against `user-message` events.

import { X } from "lucide";
import { icon } from "./icons.js";
import { failure, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { appendTurn, excerptText, followTail, type QuoteSource, scrollBottom, turnsPane } from "./chat.js";
import { imageThumb } from "./attachments.js";
import { fileMarker, MAX_INBOUND_BYTES } from "../../core/inbound-file.js";
import { QUOTE_CHARS, withQuote } from "../../core/identity.js";
import { escapeKey, letterKey } from "./shortcut.js";
import { listStep } from "./menu.js";
import { CHAT_COMMANDS, type ChatCommand, type SessionState } from "../../core/types.js";
import type { ParkedMessage } from "../../tasks/types.js";

/** A file picked but not yet sent. The upload starts on attach, so Enter
 *  usually finds its marker already there and the send paints at once. */
interface PendingFile {
  data: string; // base64
  mimeType: string;
  name?: string; // absent for a pasted screenshot — the server derives one
  marker: Promise<string | null>; // null: the upload failed
}

/** Everything the composer needs from the orchestrator (main.ts). */
interface ComposerDeps {
  sessionId: () => string | null;
  sessionState: () => SessionState;
  chatVisible: () => boolean;
  setState: (state: SessionState) => void;
  /** Reload the session snapshot if `id` is still the selected session. */
  reload: (id: string) => Promise<void>;
  /** The continuous conversation is on screen: sends go to its head, whichever
   *  that is by then; otherwise to the child session on screen. */
  continuous: () => boolean;
  /** The head a continuous send landed on is not the one on screen. */
  headMoved?: () => void;
}

let deps: ComposerDeps;

const composer = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendBtn = $<HTMLButtonElement>("#send");
const sendArrow = $("#send-arrow");
const sendQueue = $("#send-queue");
const stopBtn = $("#stop");
const queuePanel = $("#queue-panel");
const queueRows = $("#queue-rows");
const queueLabel = $("#queue-label");
const queueActions = $("#queue-actions");
const imageStrip = $("#image-strip");
const quoteStrip = $("#quote-strip");
const commandMenu = $("#command-menu");
const attachInput = $<HTMLInputElement>("#attach-input");

let queueHasRows = false;
let queueVersion = 0;
// Only the snapshot knows these (Pi's queue-state events do not), so a render
// without them keeps the last ones.
let parked: ParkedMessage[] = [];
let piQueue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
const recalling = new Set<string>();
let pendingFiles: PendingFile[] = [];
// The row the next send answers; one per session, like the files.
let pendingQuote: QuoteSource | null = null;
const quoteBySession = new Map<string, QuoteSource>();
// Texts already rendered optimistically, awaiting their user-message event so
// the same turn isn't drawn twice.
let optimisticUserTexts: string[] = [];

/** iOS neither shrinks the layout viewport for the keyboard nor drops
 *  `env(safe-area-inset-bottom)` behind it; the visual viewport is the only
 *  thing that knows the real numbers. */
function trackKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = (): void => {
    // Not `> 0`: the accessory bar alone is ~44px. A pinch-zoom shrinks the
    // visual viewport too, and pinning the body to that would collapse the app.
    const up = vv.scale <= 1.05 && window.innerHeight - vv.height - vv.offsetTop > 80;
    if (up) document.body.dataset.kb = "";
    else delete document.body.dataset.kb;
    document.body.style.height = up ? `${String(vv.height)}px` : "";
    // The height above already made the room iOS scrolled for.
    if (up && window.scrollY) window.scrollTo(0, 0);
  };
  // The keyboard arrives as a resize, the scroll under it as an offset change.
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}

/** The dock floats over the transcript, so the pane pads its tail by the dock's
 *  live height. Border-box: a content-box round is not delivered when only
 *  padding changes, and the home-indicator inset is padding. */
function trackDock(): void {
  const main = composer.parentElement!;
  const parts = [queuePanel, composer];
  const sync = (): void => {
    const height = parts.reduce((sum, el) => sum + el.offsetHeight, 0);
    main.style.setProperty("--dock-h", `${String(height)}px`);
  };
  const ro = new ResizeObserver(sync);
  for (const el of parts) ro.observe(el, { box: "border-box" });
}

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

/** The composer buttons are the state display. */
export function updateComposer(): void {
  const streaming = deps.sessionState() === "streaming";
  // No id, nothing to send to: send() would drop the prompt on the floor, so
  // the button says so before it is pressed rather than after.
  const ready = deps.sessionId() !== null || deps.continuous();
  sendBtn.disabled = !ready;
  sendBtn.className = `flex h-7 w-7 flex-none items-center justify-center rounded-lg ${
    !ready
      ? "cursor-default bg-neutral-100 text-neutral-400"
      : streaming
        ? "cursor-pointer bg-amber-100 text-amber-700 hover:bg-amber-200 active:bg-amber-300"
        : "cursor-pointer bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 dark:text-neutral-50"
  }`;
  sendBtn.title = !ready ? "No session" : streaming ? "Queue — delivered when the turn ends" : "Send";
  sendArrow.classList.toggle("hidden", streaming);
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

export function renderQueue(steering: string[], followUp: string[], parkedNow = parked): void {
  ++queueVersion;
  parked = parkedNow;
  piQueue = { steering, followUp };
  const rows = [
    ...steering.map((text) => ({ mode: "steer", text })),
    ...followUp.map((text) => ({ mode: "queued", text })),
    ...parked.map((p) => ({ mode: `after this turn · ${p.runName}`, text: p.text })),
  ];
  queueHasRows = rows.length > 0;
  // The count sits on the label so the header actions read as queue-wide.
  queueLabel.textContent = rows.length > 1 ? `Queued · ${rows.length}` : "Queued";
  // The actions are Pi's whole-queue primitives; a parked row is its sender's
  // to `pier task cancel`, never recalled or sent from here.
  const own = steering.length + followUp.length > 0;
  queueActions.classList.toggle("hidden", !own);
  queueActions.classList.toggle("flex", own);
  syncQueuePanel();
  queueRows.replaceChildren(
    ...rows.map((r) => {
      const li = h("li", "flex items-start gap-2 text-[13px] leading-[18px]");
      // Plain queued rows need no badge: the panel's own label already says so;
      // a steer deviates from it, a parked row names whose it is.
      if (r.mode === "steer") {
        li.append(h("span", "flex-none rounded bg-indigo-100 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700", r.mode));
      } else if (r.mode !== "queued") {
        li.append(h("span", "max-w-[40%] flex-none truncate rounded bg-neutral-100 px-1 py-0.5 text-[10.5px] font-semibold text-neutral-600", r.mode));
      }
      li.append(h("span", "min-w-0 whitespace-pre-wrap break-words text-neutral-700", r.text));
      return li;
    }),
  );
}

/** A parked follow-up reached the session's transcript. */
export function dropParked(messageId: string): void {
  if (parked.some((p) => p.messageId === messageId)) {
    renderQueue(piQueue.steering, piQueue.followUp, parked.filter((p) => p.messageId !== messageId));
  }
}

// --- pending attachment strip ------------------------------------------------------

const MAX_FILES = 8;

function renderFileStrip(): void {
  // Empty is not a value, exactly as an empty draft is a removed key below.
  const id = deps.sessionId();
  if (id && pendingFiles.length) pendingBySession.set(id, pendingFiles);
  else if (id) pendingBySession.delete(id);
  imageStrip.classList.toggle("hidden", pendingFiles.length === 0);
  imageStrip.classList.toggle("flex", pendingFiles.length > 0);
  imageStrip.replaceChildren(
    ...pendingFiles.map((f, i) => {
      // The chat tile, so a pending image looks like the sent one and clicking
      // it opens the same lightbox (paging across the strip, not the transcript).
      const body = f.mimeType.startsWith("image/")
        ? imageThumb(`data:${f.mimeType};base64,${f.data}`)
        : h("span", "flex h-16 max-w-40 items-center truncate rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[12px] text-neutral-700", f.name ?? "file");
      const remove = h("button", "absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-neutral-700 text-[10px] leading-none text-white hover:bg-red-600", icon(X, "h-3 w-3"));
      remove.setAttribute("type", "button");
      remove.setAttribute("aria-label", `Remove ${f.name ?? "attachment"}`);
      remove.onclick = () => {
        pendingFiles.splice(i, 1);
        renderFileStrip();
      };
      return h("div", "relative", body, remove);
    }),
  );
}

/** Reply pressed on a row: the excerpt shows over the input until sent or
 *  dismissed; a second press replaces it. */
export function setQuote(source: QuoteSource | null): void {
  pendingQuote = source;
  const id = deps.sessionId();
  if (id && source) quoteBySession.set(id, source);
  else if (id) quoteBySession.delete(id);
  quoteStrip.classList.toggle("hidden", !source);
  quoteStrip.classList.toggle("flex", !!source);
  if (!source) {
    quoteStrip.replaceChildren();
    return;
  }
  const excerpt = h("div", "quote-excerpt min-w-0 flex-1 text-[12.5px] leading-snug text-neutral-600", excerptText(source.text.slice(0, QUOTE_CHARS)));
  const remove = h("button", "flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-200", icon(X, "h-3.5 w-3.5"));
  remove.setAttribute("type", "button");
  remove.setAttribute("aria-label", "Remove quote");
  remove.onclick = () => {
    setQuote(null);
    focusInput();
  };
  quoteStrip.replaceChildren(h("div", "quote-block flex min-w-0 flex-1 items-start gap-1", excerpt, remove));
  focusInput();
}

function addFile(file: File): void {
  // A refused file says so (§5) — a picker that swallows picks reads as broken.
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
    pendingFiles.push(withUpload({
      data: url.slice(url.indexOf(",") + 1),
      mimeType: file.type || "application/octet-stream",
      name: file.name || undefined,
    }));
    renderFileStrip();
  };
  reader.readAsDataURL(file);
}

/** Marker line built with the shared grammar (core/inbound-file.ts), so the
 *  optimistic render is exactly what every other surface will see. */
function withUpload({ data, mimeType, name }: Omit<PendingFile, "marker">): PendingFile {
  const f = { data, mimeType, name };
  const marker = sendJson("/api/inbox", f)
    .then(async (res) => (res.ok ? fileMarker(((await res.json()) as { path: string }).path) : null))
    .catch(() => null); // a failed send reports it (§5) and re-arms the upload
  return { ...f, marker };
}

async function uploadFiles(files: PendingFile[]): Promise<string[] | null> {
  const markers = await Promise.all(files.map((f) => f.marker));
  return markers.every((m): m is string => m !== null) ? markers : null;
}

// --- chat commands and skills ---------------------------------------------------------
// One list while the draft is `/` plus a prefix: the chain commands where the
// continuous conversation is on screen — anywhere else `/status` is a message
// (core/chain.ts) — then the skills Pi loaded for the open session, which it
// expands as `/skill:<name>` anywhere. A chain command's exact word hides the
// list (Enter then sends it); a skill's never does, since it still needs the ask.

interface CommandRow { word: string; line: string; fill: string }

let skills: { name: string; description: string }[] = [];
let commandRows: HTMLElement[] = [];
let commandActive = 0;
let commandDismissed = false; // Esc, until the draft changes

/** The open session's skills, from its history snapshot. */
export function setSkills(next: { name: string; description: string }[]): void {
  skills = next;
  renderCommandMenu();
}

function commandMatches(): CommandRow[] {
  const draft = input.value;
  if (!draft.startsWith("/") || /\s/.test(draft) || commandDismissed) return [];
  const prefix = draft.slice(1);
  const chain = deps.continuous() ? (Object.keys(CHAT_COMMANDS) as ChatCommand[]) : [];
  if (chain.some((c) => c === prefix)) return [];
  return [
    ...chain.filter((c) => c.startsWith(prefix)).map((c) => ({ word: `/${c}`, line: CHAT_COMMANDS[c], fill: `/${c}` })),
    ...skills.filter((s) => `skill:${s.name}`.startsWith(prefix) || s.name.startsWith(prefix))
      .map((s) => ({ word: `/skill:${s.name}`, line: s.description, fill: `/skill:${s.name} ` })),
  ];
}

const commandMenuOpen = (): boolean => commandRows.length > 0;

function setCommandActive(index: number): void {
  if (!commandRows.length) return;
  commandActive = (index + commandRows.length) % commandRows.length;
  for (const [i, el] of commandRows.entries()) {
    el.classList.toggle("bg-indigo-50", i === commandActive); // the palette's selection vocabulary (style.css)
    el.setAttribute("aria-selected", String(i === commandActive));
  }
  commandRows[commandActive]!.scrollIntoView({ block: "nearest" }); // past eight rows the list scrolls
}

/** A skill's fill ends in a space: that closes the list, and the caret waits for the ask. */
function pickCommand(row: CommandRow): void {
  input.value = row.fill; // assignment parks the caret at the end
  input.focus();
  autosize();
  saveDraft();
  renderCommandMenu();
}

function renderCommandMenu(): void {
  const matches = commandMatches();
  commandRows = matches.map((row) => {
    const li = h("li", "palette-row col-span-2 grid min-h-9 cursor-pointer grid-cols-subgrid items-center gap-x-3 rounded-[10px] px-2.5 py-1.5 text-[14px] leading-5 text-neutral-800",
      h("span", "font-mono", row.word),
      h("span", "min-w-0 truncate text-[13px] text-neutral-500", row.line));
    li.setAttribute("role", "option");
    // pointerdown's preventDefault keeps the textarea focused (a click would blur
    // it and drop the phone's keyboard); the pick waits for pointerup so a finger
    // scrolling the list past eight rows does not fill whatever it touched first.
    let downY: number | undefined;
    li.onpointerdown = (ev) => {
      ev.preventDefault();
      downY = ev.clientY;
    };
    li.onpointerup = (ev) => {
      if (downY !== undefined && Math.abs(ev.clientY - downY) < 8) pickCommand(row);
      downY = undefined;
    };
    return li;
  });
  commandMenu.replaceChildren(...commandRows);
  commandMenu.classList.toggle("hidden", !commandRows.length);
  commandMenu.classList.toggle("grid", commandRows.length > 0);
  setCommandActive(0);
}

/** The keys the open list takes from the textarea; false leaves the key to it. */
function commandMenuKey(ev: KeyboardEvent): boolean {
  if (!commandMenuOpen()) return false;
  const step = listStep(ev);
  if (step !== undefined) setCommandActive(commandActive + step);
  else if (ev.key === "Enter" || ev.key === "Tab") pickCommand(commandMatches()[commandActive]!);
  else if (ev.key === "Escape") {
    commandDismissed = true;
    renderCommandMenu();
  } else return false;
  ev.preventDefault();
  return true;
}

// --- composer drafts -------------------------------------------------------------------
// Per session, in sessionStorage only: an unsent draft is never the agent's
// business, and a board's own script runs on this origin (boards/boards.ts) —
// in another tab, which is what keeps it out of reach.

const DRAFT_PREFIX = "pier.draft.";
const draftKey = (id: string): string => `${DRAFT_PREFIX}${id}`;
let draftVersion = 0;

/** Drafts were kept in localStorage until they became tab-scoped, and a board's
 *  script reads that store on this origin — so an upgraded workbench moves what
 *  is left into this tab and deletes the exposed copies. Storage can be denied
 *  outright (private mode, blocked cookies), which costs the move, not the boot. */
function adoptStoredDrafts(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) stale.push(key);
    }
    for (const key of stale) {
      const text = localStorage.getItem(key);
      // This tab's own draft is the newer one; the old copy only fills a gap.
      if (text && !sessionStorage.getItem(key)) sessionStorage.setItem(key, text);
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn("could not move older drafts out of localStorage", err);
  }
}

/** In memory, not sessionStorage: a couple of pasted screenshots are past what
 *  it will hold. Survives switching sessions, not a reload. Written from
 *  renderFileStrip, which every mutation of `pendingFiles` goes through. */
const pendingBySession = new Map<string, PendingFile[]>();

export function saveDraft(id = deps.sessionId(), text = input.value): void {
  if (!id) return;
  if (text) sessionStorage.setItem(draftKey(id), text);
  else sessionStorage.removeItem(draftKey(id));
}

export function restoreDraft(id: string): void {
  ++draftVersion;
  input.value = sessionStorage.getItem(draftKey(id)) ?? "";
  autosize();
  commandDismissed = false;
  renderCommandMenu();
  pendingFiles = pendingBySession.get(id) ?? [];
  renderFileStrip();
  setQuote(quoteBySession.get(id) ?? null);
}

/** A changed height re-pins the tail in the same frame: left to the
 *  ResizeObserver it lands a frame later, and the last message bounces once
 *  per wrap — with an IME, once per candidate. */
function autosize(): void {
  const was = input.style.height;
  input.style.height = "auto";
  const next = `${Math.min(input.scrollHeight, 192)}px`; // cap = max-h-48
  input.style.height = next;
  if (next !== was) scrollBottom();
}

// --- sending ---------------------------------------------------------------------------

let sending = false; // uploads await; a second Enter meanwhile must not double-send

/** `label` sends that text instead of the composer's — a next-step button
 *  click is a side action and must not consume the user's unsent draft. */
export async function send(mode: "auto" | "steer", label?: string): Promise<void> {
  const typed = (label ?? input.value).trim();
  const files = label === undefined ? pendingFiles : [];
  const id = deps.sessionId();
  const continuous = deps.continuous();
  if ((!typed && files.length === 0) || (!id && !continuous)) return;
  if (label === undefined) {
    if (sending) return;
    sending = true;
    // Cleared before any await: whatever is typed while an upload runs is a
    // new draft, not collateral of this send.
    input.value = "";
    autosize();
    saveDraft();
    renderCommandMenu();
    pendingFiles = [];
    renderFileStrip();
  }
  // A command or skill ask is not a reply: the quote stays staged for the next message.
  const quote = label === undefined && !/^[/%]/.test(typed) ? pendingQuote : null;
  if (quote) setQuote(null);
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
        pendingFiles = files.map(withUpload); // fresh uploads: the failed ones are spent
        renderFileStrip();
        setQuote(quote);
        return;
      }
      markers = uploaded;
    }
    const body = [typed, ...markers].filter(Boolean).join("\n");
    const text = quote ? withQuote(quote, body) : body;
    const startsTurn = deps.sessionState() === "idle" && mode === "auto";
    if (startsTurn) deps.setState("streaming");
    else updateComposer();
    // Optimistic; only a message sent into an existing run waits for the
    // queue-state snapshot.
    if (startsTurn || mode === "steer") {
      markOptimisticUser(text);
      appendTurn("user", text, false, Date.now());
      scrollBottom(true);
    }
    const res = await sendJson(continuous ? "/api/continuous/messages" : `/api/sessions/${id}/messages`, { text, mode });
    if (!res.ok) {
      // The body names the cause when there is one — a session that cannot open, say.
      // After the reload, which wipes the pane an error row would go into.
      const why = await failure(res, "send failed");
      if (id) await deps.reload(id);
      appendTurn("error", why);
    } else if (continuous) {
      const { sessionId, command } = (await res.json()) as { sessionId: string; command?: string };
      // A command is answered without a turn, so no state event ends the optimistic one.
      if (command && startsTurn) deps.setState("idle");
      if (sessionId !== id) deps.headMoved?.();
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
  if (!res.ok) {
    const why = await failure(res, `Queue ${mode} failed`);
    await deps.reload(id);
    if (deps.sessionId() === id) appendTurn("error", why);
  }
}

async function recallQueue(): Promise<void> {
  const id = deps.sessionId();
  if (!id || recalling.has(id)) return;
  recalling.add(id);
  const queueAtStart = queueVersion;
  const draftAtStart = draftVersion;
  const focusAtStart = document.activeElement;
  try {
    // Checkpointed: the selection may move before the answer lands.
    saveDraft();
    const res = await fetch(`/api/sessions/${id}/queue/recall`, { method: "POST" });
    if (!res.ok) {
      const why = await failure(res, "Could not recall queued messages");
      if (deps.sessionId() === id) appendTurn("error", why);
      return;
    }
    const { messages } = (await res.json()) as { messages: string[] };
    const selected = deps.sessionId() === id;
    if (messages.length) {
      // The server already removed these messages: retain them even after navigation.
      try {
        const draft = selected ? input.value : sessionStorage.getItem(draftKey(id)) ?? "";
        const text = (draft ? [draft, ...messages] : messages).join("\n");
        if (selected) {
          input.value = text;
          autosize();
          if (draftAtStart === draftVersion && deps.chatVisible() && document.activeElement === focusAtStart) input.focus();
        }
        saveDraft(id, text);
      } catch (error) {
        appendTurn("error", `Could not save recalled messages for session ${id}: ${String(error)}\nRecalled messages (not saved):\n${messages.join("\n")}`);
      }
    }
    // A newer snapshot/event (including a reselected session) owns the queue now.
    if (selected && queueAtStart === queueVersion) renderQueue([], []);
  } finally {
    recalling.delete(id);
  }
}

// --- wiring ----------------------------------------------------------------------------

export function initComposer(d: ComposerDeps): void {
  deps = d;
  adoptStoredDrafts();
  trackKeyboard();
  trackDock();
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
  // "/" is where Slack, GitHub and Discord put this.
  letterKey(input, ["/"], "Write a message", focusInput, deps.chatVisible);
  // Focusing the composer means the user is watching the tail.
  input.onfocus = followTail;
  input.oninput = () => {
    autosize();
    saveDraft();
    commandDismissed = false;
    renderCommandMenu();
  };
  // A touch keyboard's Enter is the only way to get a newline (there is no
  // Shift), so there it types one and the send button is the only send.
  const enterSends = !matchMedia("(pointer: coarse)").matches;
  input.onkeydown = (ev) => {
    // IME guard: Enter that confirms a composition candidate must not send
    // (isComposing covers modern browsers; 229 covers stragglers).
    if (ev.isComposing || ev.keyCode === 229) return;
    if (commandMenuKey(ev)) return;
    if (ev.key === "Escape" && pendingQuote && !input.value.trim()) {
      ev.preventDefault();
      setQuote(null);
      return;
    }
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
