// The selected session's header: title row, meta chips and the ⋯ menu. Owns
// the model/context state the snapshot reports.

import { ArrowLeft, LoaderCircle, X } from "lucide";
import { icon } from "./icons.js";
import { compact } from "../../core/reply.js";
import { getJson, mustGetJson, sendJson } from "./api.js";
import { appendTurn, revealActiveRun } from "./chat.js";
import { $, agoLabel, basename, copyBtn, h, stampTime, untitled } from "./dom.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
import { chord, chordLabel, modalOpen } from "./shortcut.js";
import { renameSession, runsLabel, type SessionInfo } from "./sidebar.js";
import type { ContextUsage, ModelRef, ThinkingLevel, TurnMeta } from "../../core/types.js";
import type { HandoffTarget } from "../../channels/types.js";

/** Everything the header needs from the orchestrator (main.ts). */
export interface HeaderDeps {
  currentId: () => string | null;
  /** The selected session's listed summary. `select` guarantees one exists
   *  for any session that does — the header hides itself when it does not. */
  currentSession: () => SessionInfo | undefined;
  /** Start another session in a cwd (main.ts) — the ⋯ menu offers it for the
   *  session's own directory, which is where the next one usually belongs. */
  createSession: (cwd: string) => void;
  /** Mobile top bar mirror (views.ts). */
  syncBar: () => void;
  /** Open the Files view on a cwd, or on nothing — which reopens the folder
   *  and diff the current session last browsed (views.ts, wired through main). */
  openFiles: (cwd?: string) => void;
  /** Same view, but a second press closes it — what the chord binds to. */
  toggleFiles: (cwd?: string) => void;
}

let deps: HeaderDeps;

export function initHeader(d: HeaderDeps): void {
  deps = d;
  // One of the ⋯ menu's actions is frequent enough to earn a chord. It acts on
  // the *current* session — the menu also opens from a rail row, which is why
  // the rows only advertise the chord when it would hit theirs.
  chord(FILES_KEY, () => {
    const s = deps.currentSession();
    if (!s) return;
    closeMenu();
    deps.toggleFiles(); // no cwd: the current session's own last folder + diff
  }, modalOpen);
}

const FILES_KEY = "i"; // no mnemonic — the menu row teaches it; ⌘E/⌘F/⌘O are taken

const chatTitle = $("#chat-title");
const chatMenu = $("#chat-menu");
const sessionMeta = $("#session-meta");

/** Backend facts, not session facts, so the first read warms every later picker. */
let catalog: ModelRef[] | null = null;
const levelsByModel = new Map<string, ThinkingLevel[]>();
const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

/** Model + context usage of the *current* session (from its snapshot). */
let currentModel: ModelRef | null = null;
let currentContext: ContextUsage | null = null;
let currentThinking: ThinkingLevel | null = null;
/** When the last assistant turn completed, ms epoch. The transcript stamps that
 *  turn itself (chat.ts); this is the same fact where "how stale is this
 *  session" is asked — without scrolling to the bottom to find out. */
let lastReplyAt: number | null = null;

/** Cleared before a snapshot (re)load — the chips must not show the old session. */
export function resetHeaderState(): void {
  currentModel = null;
  currentContext = null;
  currentThinking = null;
  lastReplyAt = null;
  renderSessionMeta();
}

/** Snapshot landed: adopt its model/context/reasoning and repaint. */
export function setHeaderState(
  model: ModelRef | null,
  context: ContextUsage | null,
  thinking: ThinkingLevel,
  lastReply: number | null,
): void {
  currentModel = model;
  currentContext = context;
  currentThinking = thinking;
  lastReplyAt = lastReply;
  renderHeader();
}

/** turn-end meta: the context size at completion keeps the chip live, and the
 *  completion time is the reading the info panel reports. */
export function noteTurnMeta(meta: TurnMeta): void {
  lastReplyAt = meta.completedAt;
  if (currentContext) currentContext = { ...currentContext, tokens: meta.tokens };
  renderSessionMeta();
}

/** The pane is the new session's before that session has an id, and it may not
 *  go on naming the one it replaced. Cleared by the first render that has a
 *  session — which is that session arriving. */
let pending: string | null = null;

export function setHeaderPending(cwd: string | null): void {
  pending = cwd === null ? null : untitled(cwd);
  renderHeader();
}

export function renderHeader(): void {
  const s = deps.currentSession();
  if (s) pending = null;
  // Selected but not a row — a task run's own session, opened from Runs or
  // Activity — is named by its id: "no session" would be untrue of a pane
  // with a transcript in it.
  chatTitle.textContent = s ? (s.title ?? untitled(s.cwd)) : (pending ?? deps.currentId() ?? "no session");
  // The title is what the panel is *about*, so it is also the way in — a click,
  // not a hover: the same gesture works on the mobile bar's title (shell.ts).
  chatTitle.classList.toggle("cursor-pointer", !!s);
  chatTitle.title = s ? "Session info" : "";
  chatTitle.onclick = s ? () => sessionInfo(chatTitle, s) : null;
  chatMenu.classList.toggle("hidden", !s);
  // Everything per-session (info, rename, model) lives in the ⋯ menu.
  if (s) chatMenu.onclick = () => sessionMenu(chatMenu, s);
  renderSessionMeta();
  deps.syncBar();
}

/** Where a context reading stops being information and becomes something to
 *  act on — the chip's amber, and the one size worth a phone's bar line. */
const CONTEXT_WARN = 70;

/** Percent of the context window used (capped at 100). */
const contextUsed = (tokens: number, u: ContextUsage): number =>
  Math.min(100, Math.round((tokens / u.contextWindow) * 100));

/** Full context reading for the session info panel. */
const contextLabel = (u: ContextUsage): string =>
  u.tokens === null
    ? `?/${compact(u.contextWindow)}`
    : `${compact(u.tokens)}/${compact(u.contextWindow)} · ${100 - contextUsed(u.tokens, u)}% left`;

/** Title-row meta: background runs · model · reasoning · current context size. */
function renderSessionMeta(): void {
  const u = currentContext;
  const tokens = u?.tokens ?? null;
  const id = deps.currentId();
  // The rail's dot count (sidebar.ts) for the session on screen, plus the way
  // to a card that has scrolled off.
  const runs = deps.currentSession()?.activeRuns ?? 0;
  const items: HTMLElement[] = [];
  if (runs > 0) {
    const chip = h(
      "button",
      "flex flex-none cursor-pointer items-center gap-1 rounded bg-sky-50 px-1.5 py-px font-medium text-sky-700 hover:bg-sky-100",
      icon(LoaderCircle, "spinner h-3 w-3"),
      `${runs} running`,
    );
    chip.title = `${runsLabel(runs)} · show the newest`;
    chip.onclick = () => {
      // The count is the server's, the card is this pane's: if the transcript
      // no longer holds one, say so rather than swallow the click.
      if (!revealActiveRun()) appendTurn("error", "no run card left in this transcript — reload the session to see it");
    };
    items.push(chip);
  }
  // Opening a session in Pi is a round trip, and during it the meta row has no
  // id and no chips to draw — which reads exactly like a session sitting idle.
  // It says which one it is instead, and the chips replace it on arrival.
  if (!id && pending) {
    items.push(h(
      "span",
      "flex flex-none items-center gap-1.5 text-neutral-500",
      icon(LoaderCircle, "spinner"),
      "starting…",
    ));
  }
  if (id) {
    const pickerButton = (text: string, cls: string): HTMLElement => {
      const button = h("button", `cursor-pointer font-mono ${cls}`, text);
      button.title = "Change model or reasoning";
      button.onclick = () => void pickModel(button, id);
      return button;
    };
    if (currentModel) {
      // The only chip of open-ended length, so it is the one that gives up
      // characters when the row cannot fit — the readings after it are short,
      // and dropping off the strip's edge is not a reading at all.
      items.push(pickerButton(
        currentModel.id,
        "min-w-0 truncate rounded bg-indigo-50 px-1.5 py-px font-medium text-indigo-700 hover:bg-indigo-100",
      ));
    }
    if (currentThinking) {
      items.push(pickerButton(currentThinking, "flex-none text-neutral-500 hover:text-indigo-700"));
    }
  }
  // Context pressure decides two things: the chip's tone, and — below md —
  // whether this row is worth a line of the bar at all.
  let pressure = 0;
  if (u && tokens !== null) {
    pressure = contextUsed(tokens, u);
    const tone = pressure >= 90 ? "text-red-700" : pressure >= CONTEXT_WARN ? "text-amber-700" : "text-neutral-500";
    items.push(h("span", `flex-none font-mono ${tone}`, compact(tokens).toLowerCase()));
  }
  const children = items.flatMap((item, i) =>
    i === 0 ? [item] : [h("span", "flex-none text-neutral-300", "·"), item],
  );
  sessionMeta.replaceChildren(...children);
  sessionMeta.classList.toggle("hidden", items.length === 0);
  sessionMeta.classList.toggle("flex", items.length > 0);
  // On a phone only three chips are worth a second line: a session still
  // opening (§5), a subagent still running, and a context near full, which is
  // acted on. style.css shows only this one below md.
  sessionMeta.toggleAttribute("data-urgent", (!id && !!pending) || runs > 0 || pressure >= CONTEXT_WARN);
}

/** Read-only details panel: what this session is and how full its context is.
 *  Opened from the ⋯ menu, from either title bar, or from a project row. */
export function sessionInfo(anchor: HTMLElement, s: SessionInfo, fromMenu = false): void {
  // The trailing relative time is supporting text, not part of the value.
  const rows: [string, string, string?][] = [
    ["Directory", s.cwd],
    ["Session", s.id],
  ];
  const current = s.id === deps.currentId();
  if (current) {
    rows.push(["Model", currentModel?.id ?? "—"]);
    // Same three readings the title row's chips carry, and in their order — the
    // panel is where they are read in full rather than glanced at.
    rows.push(["Reasoning", currentThinking ?? "—"]);
    rows.push(["Context", currentContext ? contextLabel(currentContext) : "—"]);
  }
  // Last, and beside the reply: only the two together say how long this session
  // has been running. Free either way — the listed summary already carries it.
  rows.push(["Created", stampTime(s.createdAt), agoLabel(s.createdAt)]);
  // The reply is live state, so only the selected session has one to report.
  if (current) {
    const at = lastReplyAt;
    rows.push(at === null ? ["Last reply", "—"] : ["Last reply", stampTime(at), agoLabel(at)]);
  }
  const panel = h("div", "w-[min(26rem,calc(100vw-2rem))] max-sm:w-full rounded-xl bg-white px-3 py-3 font-sans text-[15px] leading-normal");
  const close = h("button", "icon-btn h-11 w-11 sm:h-8 sm:w-8", icon(X));
  close.setAttribute("aria-label", "Close session info");
  close.onclick = closeMenu;
  const heading = h("div", "sticky top-0 z-10 flex items-start gap-2 bg-white pb-2",
    h("div", "min-w-0 flex-1",
      h("div", "text-sm font-medium text-neutral-500", "Session info"),
      h("h2", "mt-1 [overflow-wrap:anywhere] text-lg leading-7 font-semibold text-neutral-900", s.title ?? untitled(s.cwd))), close);
  if (fromMenu) {
    const back = h("button", "icon-btn h-11 w-11 sm:h-8 sm:w-8", icon(ArrowLeft));
    back.setAttribute("aria-label", "Back to session actions");
    back.onclick = () => sessionMenu(anchor, s);
    heading.prepend(back);
  }
  panel.append(heading);
  const fields = h("dl", "");
  for (const [label, value, note] of rows) {
    const identifier = label === "Directory" || label === "Session";
    const shown = h("dd", `min-w-0 flex items-start gap-2 text-neutral-700 ${identifier ? "font-mono text-sm leading-6" : ""}`,
      h("span", "min-w-0 flex-1 [overflow-wrap:anywhere]", value));
    if (identifier) {
      const copy = copyBtn("min-h-11 min-w-11 sm:min-h-8 shrink-0 cursor-pointer rounded-lg px-2 py-1 text-[13px] font-sans text-neutral-500 hover:bg-neutral-100 focus-visible:outline-2", () => value);
      copy.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
      shown.append(copy);
    }
    if (note) shown.firstElementChild?.append(h("span", "ml-2 inline-block font-sans text-[13px] leading-5 text-neutral-500", note));
    const boundary = label === "Model" || label === "Created";
    fields.append(h("div", `grid gap-1 py-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-3 ${boundary ? "mt-2 border-t border-neutral-200 pt-2.5" : ""}`,
      h("dt", "text-[15px] text-neutral-500", label === "Session" ? "Session ID" : label), shown));
  }
  panel.append(fields);
  openPanel(anchor, panel);
}

async function pickModel(anchor: HTMLElement, id: string, session?: SessionInfo): Promise<void> {
  const loading = h("div", "px-3 py-3 text-[15px] text-neutral-500", "Loading models…");
  const content = h("div", "w-[min(24rem,calc(100vw-2rem))] min-w-0 max-sm:w-full", loading);
  // What the panel is showing right now — the placeholder, then the picker the
  // cache drew, then the picker the read reconciled.
  let shown: HTMLElement = loading;
  if (session) content.prepend(panelHead(anchor, session, "Close model picker"));
  openPanel(anchor, content);
  // Closing or replacing the panel cancels presentation of an in-flight read.
  const visible = (): boolean => shown.isConnected && !shown.closest("[inert]");
  // A reconcile that changes nothing must not redraw: it would drop the search
  // the user typed and collapse the group they just opened.
  let drawn = "";
  const draw = (models: ModelRef[], level: ThinkingLevel, levels: ThinkingLevel[]): void => {
    const state = JSON.stringify([models, level, levels]);
    if (state === drawn) return;
    drawn = state;
    const picker = modelPicker({
      models,
      current: id === deps.currentId() ? currentModel : null,
      thinkingLevel: level,
      thinkingLevels: levels,
      onPick: (m, thinking) => {
        closeMenu();
        void applyModel(id, m, thinking);
      },
      onThinkingPick: (picked) => void setThinkingLevel(id, picked),
    });
    shown.replaceWith(picker);
    shown = picker;
    openPanel(anchor, content);
  };
  // Only the current session's model and level are known here, so only its
  // picker opens on the cache; another session's still waits for the read.
  const warm = id === deps.currentId() && currentModel ? levelsByModel.get(modelKey(currentModel)) : undefined;
  if (catalog && warm && currentThinking) draw(catalog, currentThinking, warm);
  try {
    const [models, thinking] = await Promise.all([
      mustGetJson<ModelRef[]>(`/api/sessions/${id}/models`, "Could not load models"),
      mustGetJson<{ level: ThinkingLevel; levels: ThinkingLevel[] }>(
        `/api/sessions/${id}/thinking`,
        "Could not read the reasoning level",
      ),
    ]);
    catalog = models;
    if (id === deps.currentId() && currentModel) levelsByModel.set(modelKey(currentModel), thinking.levels);
    if (!visible()) return;
    draw(models, thinking.level, thinking.levels);
  } catch (err) {
    // A cached picker is on screen and may be out of date, so the failure goes
    // to the transcript rather than replacing a list the user can still use.
    if (drawn) appendTurn("error", `model options are stale: ${String(err)}`);
    else if (visible()) {
      loading.textContent = `Could not load models: ${String(err)}`;
      loading.setAttribute("role", "alert");
    } else {
      appendTurn("error", `model options failed: ${String(err)}`);
    }
  }
}

/** Model, then reasoning — in that order and only on success, because which
 *  levels exist depends on the model (Pi clamps an unsupported one). */
async function applyModel(id: string, model: ModelRef, thinking?: ThinkingLevel): Promise<void> {
  if (!(await setModel(id, model))) return;
  if (thinking) await setThinkingLevel(id, thinking);
}

async function setModel(id: string, model: ModelRef): Promise<boolean> {
  const previous = currentModel;
  if (id === deps.currentId()) {
    currentModel = model; // optimistic; the POST response is the truth
    renderHeader();
  }
  const res = await sendJson(`/api/sessions/${id}/model`, model);
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    if (id === deps.currentId()) {
      currentModel = previous; // the optimistic chip was a lie; take it back
      renderHeader();
    }
    appendTurn("error", `model change failed: ${error ?? res.status}`);
    return false;
  }
  const { model: applied } = (await res.json()) as { model: ModelRef | null };
  if (id === deps.currentId() && applied) {
    currentModel = applied;
    renderHeader();
  }
  return true;
}

/** Pi clamps an unsupported level, so the response — not the request — is
 *  what the header reports. */
async function setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
  const res = await sendJson(`/api/sessions/${id}/thinking`, { level });
  if (!res.ok) {
    appendTurn("error", `reasoning change failed: ${res.status}`);
    return;
  }
  const { level: applied } = (await res.json()) as { level: ThinkingLevel };
  if (id === deps.currentId()) {
    currentThinking = applied;
    renderSessionMeta();
  }
}

/** Head of a follow-up panel: back to the menu, the session's name, close. */
function panelHead(anchor: HTMLElement, s: SessionInfo, closeLabel: string): HTMLElement {
  const back = h("button", "icon-btn h-11 w-11", icon(ArrowLeft));
  back.setAttribute("aria-label", "Back to session actions");
  back.onclick = () => sessionMenu(anchor, s);
  const close = h("button", "icon-btn h-11 w-11", icon(X));
  close.setAttribute("aria-label", closeLabel);
  close.onclick = closeMenu;
  const title = h("span", "min-w-0 flex-1 truncate text-sm font-medium", s.title ?? untitled(s.cwd));
  title.title = title.textContent ?? "";
  return h("div", "flex items-center gap-2 border-b border-neutral-200 pb-2 mb-2", back, title, close);
}

/** The chats a web session can be continued in; a pick posts the handoff and
 *  the rail's chip follows from `sessions-changed`. A refusal stays under the
 *  row it answers, as the directory picker's errors do. */
async function handoffPicker(anchor: HTMLElement, s: SessionInfo): Promise<void> {
  const status = h("p", "px-3 py-2 text-[15px] text-neutral-500", "Loading chats…");
  const content = h("div", "w-[min(24rem,calc(100vw-2rem))] min-w-0 max-sm:w-full",
    panelHead(anchor, s, "Close chat picker"),
    h("div", "px-3 pb-1 text-sm font-medium text-neutral-500", "Continue in a chat"),
    h("p", "px-3 pb-2 text-[13px] text-neutral-500", "Chats the bot has seen. A chat appears here after its first message to the bot."),
    status);
  openPanel(anchor, content);
  const got = await getJson<{ targets: HandoffTarget[] }>("/api/handoff/targets", "Could not list chats");
  if (!content.isConnected) return;
  if (!got.ok) {
    status.textContent = got.error;
    status.setAttribute("role", "alert");
    return;
  }
  if (!got.value.targets.length) {
    status.textContent = "No chats yet — message the bot once in Lark or Slack, then come back.";
    return;
  }
  const error = h("p", "hidden px-3 pt-1 text-[13px] text-red-600");
  error.setAttribute("role", "alert");
  const list = h("div", "");
  list.dataset.list = "";
  for (const t of got.value.targets) {
    const row = h("button", "flex w-full min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-indigo-50 hover:text-indigo-700 active:bg-indigo-100",
      h("span", "min-w-0 truncate", `${t.platform[0]!.toUpperCase()}${t.platform.slice(1)} · ${t.kind === "dm" ? "DM" : "group"} · ${t.name || t.chatId}`));
    row.onclick = async () => {
      const res = await sendJson("/api/handoff", { sessionId: s.id, platform: t.platform, chatId: t.chatId });
      if (res.ok) return closeMenu();
      error.textContent = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `handoff failed: ${String(res.status)}`;
      error.classList.remove("hidden");
    };
    list.append(row);
  }
  status.replaceWith(list, error);
  list.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

/** Same menu from the chat header and from a rail row's ⋯ button. */
export function sessionMenu(anchor: HTMLElement, s: SessionInfo): void {
  const current = s.id === deps.currentId();
  openMenu(anchor, [
    {
      label: "Rename…",
      onSelect: () => {
        closeMenu();
        void renameSession(s);
      },
    },
    {
      label: "Session info",
      onSelect: () => sessionInfo(anchor, s, true),
    },
    {
      label: "New session here",
      separatorBefore: true,
      hint: basename(s.cwd),
      onSelect: () => {
        closeMenu();
        deps.createSession(s.cwd);
      },
    },
    {
      label: "Browse files",
      hint: current ? chordLabel(FILES_KEY) : "",
      onSelect: () => {
        closeMenu();
        deps.openFiles(current ? undefined : s.cwd);
      },
    },
    {
      label: "Continue in Lark/Slack…",
      ...(s.channel && s.channel !== "web" ? { hint: `answers in ${s.channel}`, disabled: true } : {}),
      onSelect: () => void handoffPicker(anchor, s),
    },
    {
      label: "Model & reasoning…",
      separatorBefore: true,
      hint: current ? (currentModel?.id ?? "…") : "",
      onSelect: () => void pickModel(anchor, s.id, s),
    },
  ], s.title ?? untitled(s.cwd));
}
