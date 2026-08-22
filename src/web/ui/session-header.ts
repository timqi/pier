// The selected session's header: its title row, the meta chips (model,
// reasoning, context usage) and the ⋯ menu — info panel, pin, model and
// reasoning pickers. Owns the model/context state the snapshot reports;
// main.ts owns which session is selected and feeds state in through init.

import { compact } from "../../core/reply.js";
import { sendJson } from "./api.js";
import { appendTurn } from "./chat.js";
import { $, copyBtn, h } from "./dom.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
import { setPinned, type SessionInfo } from "./sidebar.js";
import type { ContextUsage, ModelRef, ThinkingLevel } from "../../core/types.js";

/** Everything the header needs from the orchestrator (main.ts). */
export interface HeaderDeps {
  currentId: () => string | null;
  /** The listed session, or main's stub for one Pi hasn't persisted yet. */
  currentSession: () => SessionInfo | undefined;
  /** Mobile top bar mirror (views.ts). */
  syncBar: () => void;
}

let deps: HeaderDeps;

export function initHeader(d: HeaderDeps): void {
  deps = d;
}

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

/** Full context reading, shared by the meta chip's hover and the info panel. */
const contextLabel = (u: ContextUsage): string =>
  u.tokens === null
    ? `?/${compact(u.contextWindow)}`
    : `${compact(u.tokens)}/${compact(u.contextWindow)} · ${100 - contextUsed(u.tokens, u)}% left`;

/** Title-row meta: the resident chip shows bare token usage ("12K tok",
 *  quiet → amber ≥ 70% used → red ≥ 90%); hover swaps in the full headroom
 *  reading and unfolds model + reasoning chips. Before the first usage
 *  report the model chip stands in as the resident hover target. An untitled
 *  session has no title to read, so it starts unfolded — the chips are then
 *  the only thing identifying it. */
function renderSessionMeta(): void {
  const chip = (tag: string, cls: string, text: string): HTMLElement =>
    h(tag, `flex-none rounded px-1.5 py-px font-mono ${cls}`, text);
  const u = currentContext;
  const tokens = u?.tokens ?? null;
  const id = deps.currentId();
  const untitled = !deps.currentSession()?.title;
  const onHover = untitled ? "" : "hidden group-hover:inline";
  const chips: HTMLElement[] = [];
  if (currentModel && id) {
    // Also the shortest path to switching models.
    const model = chip(
      "button",
      `${tokens === null ? "" : onHover} cursor-pointer bg-indigo-50 font-medium text-indigo-700 hover:bg-indigo-100`,
      currentModel.id,
    );
    model.title = "Change model";
    model.onclick = () => void pickModel(model, id);
    chips.push(model);
  }
  if (currentThinking && currentThinking !== "off") {
    chips.push(chip("span", `${onHover} bg-neutral-100 text-neutral-500`, `reasoning ${currentThinking}`));
  }
  if (u && tokens !== null) {
    const used = contextUsed(tokens, u);
    const tone =
      used >= 90
        ? "bg-red-50 text-red-700"
        : used >= 70
          ? "bg-amber-50 text-amber-700"
          : "bg-neutral-100 text-neutral-500";
    const ctx = chip("span", tone, "");
    if (untitled) ctx.textContent = contextLabel(u);
    else
      ctx.append(
        h("span", "group-hover:hidden", `${compact(tokens)} tok`),
        h("span", onHover, contextLabel(u)),
      );
    chips.push(ctx);
  }
  sessionMeta.replaceChildren(...chips);
  sessionMeta.classList.toggle("hidden", chips.length === 0);
  sessionMeta.classList.toggle("flex", chips.length > 0);
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
  const [modelsRes, thinkingRes] = await Promise.all([
    fetch(`/api/sessions/${id}/models`),
    fetch(`/api/sessions/${id}/thinking`),
  ]);
  if (!modelsRes.ok || !thinkingRes.ok) return;
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

/** Same menu from the chat header and from a project row's ⋯ button. */
export function sessionMenu(anchor: HTMLElement, s: SessionInfo): void {
  openMenu(anchor, [
    {
      label: "Session info",
      onSelect: () => sessionInfo(anchor, s),
    },
    {
      label: s.pinned ? "Remove from Projects" : "Pin to Projects",
      checked: s.pinned,
      onSelect: () => {
        closeMenu();
        void setPinned(s, !s.pinned);
      },
    },
    {
      label: "Model",
      hint: s.id === deps.currentId() ? (currentModel?.id ?? "…") : "",
      onSelect: () => void pickModel(anchor, s.id),
    },
  ]);
}
