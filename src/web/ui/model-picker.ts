// Grouped model list, provider by provider, plus the launch-config field that
// wraps it. A standalone component because model choice shows up outside chat
// too (IM chat defaults, scheduled tasks).

import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { h } from "./dom.js";
import { btn, CONTROL, field } from "./form.js";
import { closeMenu, openPanel } from "./menu.js";

export interface ModelPickerProps {
  models: ModelRef[];
  current?: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  /** A starred combo passes its reasoning level; the caller must apply the
   *  model first, because supported levels depend on the model. */
  onPick: (model: ModelRef, thinking?: ThinkingLevel) => void;
  onThinkingPick: (level: ThinkingLevel) => void;
}

const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

// Starred model+reasoning pairs, pinned above the provider groups so the combos
// you actually switch between are one click away. Browser-local preference; the
// picker owns it because nothing else reads it.
const FAVORITES_KEY = "pier.modelFavorites";

type Favorite = ModelRef & { thinking: ThinkingLevel };

const favoriteKey = (f: Favorite): string => `${modelKey(f)}@${f.thinking}`;

function loadFavorites(): Favorite[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((f): f is Favorite => {
      const c = f as Partial<Favorite> | null;
      return (
        !!c &&
        typeof c === "object" &&
        typeof c.provider === "string" &&
        typeof c.id === "string" &&
        typeof c.thinking === "string"
      );
    });
  } catch {
    return [];
  }
}

/** Model row: the label picks, the star toggles the model+reasoning favorite.
 *  Two sibling buttons — nesting one inside the other would be invalid HTML. */
function modelRow(opts: {
  label: string;
  hint?: string;
  checked: boolean;
  starred: boolean;
  onSelect: () => void;
  onStar: () => void;
}): HTMLElement {
  const pick = h(
    "button",
    "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left",
    h("span", "w-3 flex-none text-indigo-600", opts.checked ? "\u2713" : ""),
    h("span", "truncate", opts.label),
  );
  if (opts.hint) pick.append(h("span", "ml-auto flex-none text-[11.5px] text-neutral-400", opts.hint));
  pick.onclick = () => opts.onSelect();
  const star = h(
    "button",
    `flex-none cursor-pointer px-2 py-1.5 leading-none ${
      opts.starred ? "text-amber-500" : "text-neutral-300 opacity-0 hover:text-amber-500 group-hover/row:opacity-100"
    }`,
    opts.starred ? "\u2605" : "\u2606",
  );
  star.title = opts.starred ? "Unstar" : "Star this model + reasoning";
  star.onclick = (ev) => {
    ev.stopPropagation();
    opts.onStar();
  };
  return h("div", "group/row flex w-full items-center hover:bg-neutral-100", pick, star);
}

export function modelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  onPick,
  onThinkingPick,
}: ModelPickerProps): HTMLElement {
  let favorites = loadFavorites();
  let level = thinkingLevel;
  const wrap = h("div", "flex w-72 flex-col");
  const controls = h("div", "flex flex-col gap-2 border-b border-neutral-200 px-2 py-2");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search models";
  search.setAttribute("aria-label", "Search models");
  search.className =
    "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-[12.5px] focus:border-indigo-400 focus:outline-none";
  controls.append(search);

  if (thinkingLevels.length) {
    const reasoning = h("label", "flex items-center gap-2 px-1 text-[12px] text-neutral-500");
    const select = document.createElement("select");
    select.className =
      "ml-auto rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12px] text-neutral-700 focus:border-indigo-400 focus:outline-none";
    select.setAttribute("aria-label", "Reasoning level");
    for (const l of thinkingLevels) {
      const option = document.createElement("option");
      option.value = l;
      option.textContent = thinkingLabel(l);
      select.append(option);
    }
    select.value = thinkingLevel;
    select.onchange = () => {
      level = select.value as ThinkingLevel;
      // A star records model + reasoning, so the list's starred marks move too.
      renderModels(search.value);
      onThinkingPick(level);
    };
    reasoning.append(h("span", "font-medium", "Reasoning"), select);
    controls.append(reasoning);
  }

  const toggleFavorite = (f: Favorite): void => {
    const key = favoriteKey(f);
    favorites = favorites.some((x) => favoriteKey(x) === key)
      ? favorites.filter((x) => favoriteKey(x) !== key)
      : [...favorites, f]; // append: starring never reshuffles the existing rows
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    renderModels(search.value);
  };

  const isStarred = (m: ModelRef, l: ThinkingLevel): boolean =>
    favorites.some((f) => favoriteKey(f) === `${modelKey(m)}@${l}`);

  const listWrap = h("div", "max-h-72 overflow-y-auto py-1");

  /** Starred combos first: picking one applies its reasoning level too. */
  const renderFavorites = (normalized: string): void => {
    const known = new Map(models.map((m) => [modelKey(m), m]));
    const rows = favorites
      .map((f) => ({ f, model: known.get(modelKey(f)) }))
      .filter(
        (r): r is { f: Favorite; model: ModelRef } =>
          !!r.model && (!normalized || modelKey(r.model).toLowerCase().includes(normalized)),
      );
    if (!rows.length) return;
    listWrap.append(
      h(
        "div",
        "px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400",
        "Starred",
      ),
      ...rows.map(({ f, model }) =>
        modelRow({
          label: model.id,
          hint: thinkingLabel(f.thinking),
          checked: !!current && modelKey(current) === modelKey(model) && level === f.thinking,
          starred: true,
          onSelect: () => onPick(model, f.thinking),
          onStar: () => toggleFavorite(f),
        }),
      ),
      h("div", "my-1 border-t border-neutral-100"),
    );
  };

  const renderModels = (query: string): void => {
    listWrap.replaceChildren();
    const normalized = query.trim().toLowerCase();
    renderFavorites(normalized);
    const groups = new Map<string, ModelRef[]>();
    for (const m of models) {
      if (normalized && !modelKey(m).toLowerCase().includes(normalized)) continue;
      const list = groups.get(m.provider);
      if (list) list.push(m);
      else groups.set(m.provider, [m]);
    }
    if (!groups.size) {
      listWrap.append(
        h(
          "div",
          "px-3 py-2 text-[12.5px] text-neutral-400",
          models.length ? "No matching models." : "No models available.",
        ),
      );
      return;
    }
    for (const [provider, list] of groups) {
      const holdsCurrent = list.some((m) => !!current && modelKey(current) === modelKey(m));
      const group = document.createElement("details");
      group.open = holdsCurrent || normalized.length > 0;
      const summary = h(
        "summary",
        "flex cursor-pointer select-none items-center gap-1.5 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400 hover:bg-neutral-100",
        h("span", "chev", "\u25b6"),
        h("span", "truncate", provider),
        h("span", "ml-auto flex-none normal-case text-neutral-300", String(list.length)),
      );
      group.append(
        summary,
        ...list.map((m) =>
          modelRow({
            label: m.id,
            checked: !!current && modelKey(current) === modelKey(m),
            starred: isStarred(m, level),
            onSelect: () => onPick(m),
            onStar: () => toggleFavorite({ provider: m.provider, id: m.id, thinking: level }),
          }),
        ),
      );
      listWrap.append(group);
    }
  };

  search.oninput = () => renderModels(search.value);
  renderModels("");
  wrap.append(controls, listWrap);
  queueMicrotask(() => search.focus());
  return wrap;
}

export interface LaunchChoice {
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
}

/**
 * Model + reasoning for the sessions a surface launches, reusing the chat
 * composer's picker: same grouping, same search, same starred model+reasoning
 * combos. "Pi default" means passing neither, so a new session starts on
 * whatever the project and Pi would have chosen.
 */
export function launchField(
  label: string,
  choice: LaunchChoice,
  models: ModelRef[],
  onChange: (next: LaunchChoice) => void,
): HTMLElement {
  const summary = choice.model
    ? `${choice.model.id}${choice.thinking ? ` · ${thinkingLabel(choice.thinking)}` : ""}`
    : choice.thinking
    ? `Pi default · ${thinkingLabel(choice.thinking)}`
    : "Pi default";
  // Not a button: a dropdown trigger that must read as the input beside it, so
  // it wears the shared control skin rather than a copy of it.
  const open = btn(
    summary,
    `${CONTROL} flex cursor-pointer items-center gap-1.5 truncate text-left hover:bg-neutral-50 ${
      choice.model ? "text-neutral-700" : "text-neutral-400"
    }`,
  );
  open.title = choice.model ? `${choice.model.provider}/${choice.model.id}` : "Whatever the project and Pi pick";
  open.onclick = () => {
    const panel = modelPicker({
      models,
      current: choice.model,
      // Unset reads as Medium in the selector; it is only written once the
      // user actually picks one, so "Pi default" survives choosing a model.
      thinkingLevel: choice.thinking ?? "medium",
      // No session to ask for a model's supported subset — this configures a
      // launch, not a live turn — and Pi clamps a level a model cannot do.
      thinkingLevels: [...THINKING_LEVELS],
      // A starred combo carries its own reasoning level; apply both at once.
      onPick: (model, thinking) => {
        closeMenu();
        onChange({ model, thinking: thinking ?? choice.thinking });
      },
      onThinkingPick: (thinking) => onChange({ ...choice, thinking }),
    });
    const clear = btn("Pi default", "w-full cursor-pointer px-3 py-1.5 text-left text-[12.5px] text-neutral-500 hover:bg-neutral-100");
    clear.onclick = () => {
      closeMenu();
      onChange({ model: null, thinking: null });
    };
    const wrap = h("div", "flex flex-col");
    wrap.append(panel, h("div", "border-t border-neutral-200"), clear);
    openPanel(open, wrap);
  };
  return field(label, open);
}
