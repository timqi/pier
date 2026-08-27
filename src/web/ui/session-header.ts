// The selected session's header: its title row, the meta chips (model,
// reasoning, context usage) and the ⋯ menu — info panel, pin, model and
// reasoning pickers, compacting the context and starting a session beside it.
// Owns the model/context state the snapshot reports; main.ts owns which
// session is selected and feeds state in through init.

import { compact } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { appendTurn } from "./chat.js";
import { $, basename, copyBtn, h } from "./dom.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
import { chord, chordLabel } from "./shortcut.js";
import { leaseDaysLeft, renameSession, setKept, setPinned, type SessionInfo } from "./sidebar.js";
import type { ContextUsage, ModelRef, ThinkingLevel } from "../../core/types.js";

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
  // Two of the ⋯ menu's actions are frequent enough to earn a chord. They act
  // on the *current* session — the menu also opens from a project row, which
  // is why the rows only advertise the chord for the one it would hit.
  chord(PIN_KEY, () => {
    const s = deps.currentSession();
    if (!s) return;
    closeMenu();
    void setPinned(s, !s.listed);
  }, modal);
  chord(FILES_KEY, () => {
    const s = deps.currentSession();
    if (!s) return;
    closeMenu();
    deps.toggleFiles(); // no cwd: the current session's own last folder + diff
  }, modal);
}

/** A modal dialog is a mode: navigating underneath it would leave it floating
 *  over a view it was never opened from, so both chords stand down. */
const modal = (): boolean => document.querySelector("dialog[open]") !== null;

const PIN_KEY = "d"; // bookmark — the gesture every browser already spells ⌘D
const FILES_KEY = "i"; // no mnemonic — the menu row teaches it; ⌘E/⌘F/⌘O are taken

const chatTitle = $("#chat-title");
const chatMenu = $("#chat-menu");
const sessionMeta = $("#session-meta");

/** Model + context usage of the *current* session (from its snapshot). */
let currentModel: ModelRef | null = null;
let currentContext: ContextUsage | null = null;
let currentThinking: ThinkingLevel | null = null;

/** Cleared before a snapshot (re)load — the chips must not show the old session. */
export function resetHeaderState(): void {
  currentModel = null;
  currentContext = null;
  currentThinking = null;
  renderSessionMeta();
}

/** Snapshot landed: adopt its model/context/reasoning and repaint. */
export function setHeaderState(
  model: ModelRef | null,
  context: ContextUsage | null,
  thinking: ThinkingLevel,
): void {
  currentModel = model;
  currentContext = context;
  currentThinking = thinking;
  renderHeader();
}

/** turn-end meta carries the context size at completion — keep the chip live. */
export function noteContextTokens(tokens: number): void {
  if (!currentContext) return;
  currentContext = { ...currentContext, tokens };
  renderSessionMeta();
}

export function renderHeader(): void {
  const s = deps.currentSession();
  chatTitle.textContent = s ? (s.title ?? "Untitled session") : "no session";
  chatMenu.classList.toggle("hidden", !s);
  // Everything per-session (info, pin, model) lives in the ⋯ menu.
  if (s) chatMenu.onclick = () => sessionMenu(chatMenu, s);
  renderSessionMeta();
  deps.syncBar();
}

/** Percent of the context window used (capped at 100). */
const contextUsed = (tokens: number, u: ContextUsage): number =>
  Math.min(100, Math.round((tokens / u.contextWindow) * 100));

/** Full context reading for the session info panel. */
const contextLabel = (u: ContextUsage): string =>
  u.tokens === null
    ? `?/${compact(u.contextWindow)}`
    : `${compact(u.tokens)}/${compact(u.contextWindow)} · ${100 - contextUsed(u.tokens, u)}% left`;

/** Title-row meta: model · reasoning · current context size. */
function renderSessionMeta(): void {
  const u = currentContext;
  const tokens = u?.tokens ?? null;
  const id = deps.currentId();
  const items: HTMLElement[] = [];
  if (id) {
    const pickerButton = (text: string, cls: string): HTMLElement => {
      const button = h("button", `flex-none cursor-pointer font-mono ${cls}`, text);
      button.title = "Change model or reasoning";
      button.onclick = () => void pickModel(button, id);
      return button;
    };
    if (currentModel) {
      items.push(pickerButton(
        currentModel.id,
        "rounded bg-indigo-50 px-1.5 py-px font-medium text-indigo-700 hover:bg-indigo-100",
      ));
    }
    if (currentThinking) {
      items.push(pickerButton(currentThinking, "text-neutral-500 hover:text-indigo-700"));
    }
  }
  if (u && tokens !== null) {
    const used = contextUsed(tokens, u);
    const tone = used >= 90 ? "text-red-700" : used >= 70 ? "text-amber-700" : "text-neutral-500";
    items.push(h("span", `flex-none font-mono ${tone}`, compact(tokens).toLowerCase()));
  }
  const children = items.flatMap((item, i) =>
    i === 0 ? [item] : [h("span", "text-neutral-300", "·"), item],
  );
  sessionMeta.replaceChildren(...children);
  sessionMeta.classList.toggle("hidden", items.length === 0);
  sessionMeta.classList.toggle("flex", items.length > 0);
}

/** Read-only details panel: what this session is and how full its context is. */
function sessionInfo(anchor: HTMLElement, s: SessionInfo): void {
  const rows: [string, string][] = [
    ["Title", s.title ?? "untitled"],
    ["Directory", s.cwd],
    ["Session", s.id],
  ];
  if (s.id === deps.currentId()) {
    rows.push(["Model", currentModel?.id ?? "—"]);
    rows.push(["Context", currentContext ? contextLabel(currentContext) : "—"]);
  }
  const panel = h("div", "flex max-w-80 flex-col gap-1.5 px-3 py-2");
  for (const [label, value] of rows) {
    // Every field is copyable — cheaper than deciding which ones deserve it.
    const head = h(
      "div",
      "flex items-center gap-1.5",
      h("span", "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", label),
      copyBtn(
        "cursor-pointer text-[10.5px] uppercase tracking-wide text-neutral-400 opacity-0 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
        () => value,
      ),
    );
    panel.append(h("div", "group flex flex-col", head, h("span", "break-all font-mono text-[12px] text-neutral-700", value)));
  }
  openPanel(anchor, panel);
}

async function pickModel(anchor: HTMLElement, id: string): Promise<void> {
  try {
    const [modelsRes, thinkingRes] = await Promise.all([
      fetch(`/api/sessions/${id}/models`),
      fetch(`/api/sessions/${id}/thinking`),
    ]);
    if (!modelsRes.ok || !thinkingRes.ok) {
      throw new Error(`HTTP ${!modelsRes.ok ? modelsRes.status : thinkingRes.status}`);
    }
    const models = (await modelsRes.json()) as ModelRef[];
    const thinking = (await thinkingRes.json()) as { level: ThinkingLevel; levels: ThinkingLevel[] };
    openPanel(
      anchor,
      modelPicker({
        models,
        current: id === deps.currentId() ? currentModel : null,
        thinkingLevel: thinking.level,
        thinkingLevels: thinking.levels,
        onPick: (m, thinking) => {
          closeMenu();
          void applyModel(id, m, thinking);
        },
        onThinkingPick: (level) => void setThinkingLevel(id, level),
      }),
    );
  } catch (err) {
    appendTurn("error", `model options failed: ${String(err)}`);
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

/** Summarize the older transcript away. Success says nothing here: what
 *  happened arrives on the session's own stream as `context-compacted`, which
 *  is where an automatic compaction shows up too — and the route is refused
 *  outright while a turn is running, which is a sentence the user must see. */
async function compactContext(id: string): Promise<void> {
  const res = await sendJson(`/api/sessions/${id}/compact`, {});
  if (!res.ok) appendTurn("error", `compact failed: ${await failure(res, "no reason given")}`);
}

/** Same menu from the chat header and from a project row's ⋯ button. */
export function sessionMenu(anchor: HTMLElement, s: SessionInfo): void {
  const current = s.id === deps.currentId();
  openMenu(anchor, [
    {
      label: "Session info",
      onSelect: () => sessionInfo(anchor, s),
    },
    {
      label: "Rename…",
      onSelect: () => {
        closeMenu();
        void renameSession(s);
      },
    },
    // Three rows, three answers to "how long does this stay in Projects": now
    // (Done), a while (the default, which says how long), forever (Keep). The
    // word for leaving is the one the rail's own ✓ button uses — one action,
    // one name, whichever surface you reach it from.
    {
      label: s.listed ? "Done — remove from Projects" : "Pin to Projects",
      hint: current ? chordLabel(PIN_KEY) : "",
      // No checkmark: it would sit on a verb, so a listed session reads as
      // "already removed". The label is the state, and it already switched.
      onSelect: () => {
        closeMenu();
        void setPinned(s, !s.listed);
      },
    },
    // Only where it can mean anything: a session Projects does not hold has no
    // lease to be exempt from.
    ...(s.listed
      ? [{
        label: "Keep — never let it age out",
        hint: s.kept ? "" : `leaves in ${leaseDaysLeft(s)}d`,
        checked: s.kept,
        onSelect: () => {
          closeMenu();
          void setKept(s, !s.kept);
        },
      }]
      : []),
    {
      label: "Model",
      hint: current ? (currentModel?.id ?? "…") : "",
      onSelect: () => void pickModel(anchor, s.id),
    },
    {
      // For every session the menu opens on, not only the selected one: this
      // is the one menu the chat header and the project rows share, so neither
      // surface needs a copy of either row (budget rule 3).
      label: "Compact context",
      onSelect: () => {
        closeMenu();
        void compactContext(s.id);
      },
    },
    {
      label: "New session here",
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
        // The current session reopens where it left off; another session's row
        // names a directory, since only the current one has a remembered diff.
        deps.openFiles(current ? undefined : s.cwd);
      },
    },
  ]);
}
