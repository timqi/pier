// Grouped model list, provider by provider, plus the launch-config field that
// wraps it. A standalone component because model choice shows up outside chat
// too (IM chat defaults, scheduled tasks).

import { Check, ChevronRight } from "lucide";
import { icon } from "./icons.js";
import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { mustGetJson } from "./api.js";
import { h } from "./dom.js";
import { btn, CONTROL, field } from "./form.js";
import { closeMenu, openPanel } from "./menu.js";
import { report } from "./report.js";

export interface ModelPickerProps {
  models: ModelRef[];
  current?: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  /** A pinned combo passes its reasoning level; the caller must apply the
   *  model first, because supported levels depend on the model. */
  onPick: (model: ModelRef, thinking?: ThinkingLevel) => void;
  onThinkingPick: (level: ThinkingLevel) => void;
}

// Radio names only need to distinguish picker instances within this page.
let reasoningGroup = 0;

const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

/** A pinned model with an optional reasoning level and operator's intent. */
type Entry = ModelRef & { thinking?: ThinkingLevel; note?: string };

// Settings → Models: the operator's instance-wide shortlist.
// The last known menu renders instantly; the fetch reconciles it.
let pinnedMenu: Entry[] | null = null;

async function loadPinned(): Promise<Entry[]> {
  const { modelMenu } = await mustGetJson<{ modelMenu: Entry[] }>(
    "/api/settings",
    "Could not read the pinned model menu",
  );
  return modelMenu;
}

/** One action selects a model and, for a pin, its optional reasoning level. */
function modelRow(opts: {
  label: string;
  hint?: string;
  /** Tooltip on the label — the pin's line of intent, when it has one. */
  title?: string;
  checked: boolean;
  onSelect: () => void;
}): HTMLElement {
  const pick = h(
    "button",
    "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100",
    icon(Check, `h-3 w-3 text-indigo-600 ${opts.checked ? "" : "invisible"}`),
    h("span", "truncate", opts.label),
  );
  if (opts.hint) pick.append(h("span", "ml-auto flex-none text-[11.5px] text-neutral-400", opts.hint));
  if (opts.title) pick.title = opts.title;
  pick.onclick = () => opts.onSelect();
  return pick;
}

export function modelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  onPick,
  onThinkingPick,
}: ModelPickerProps): HTMLElement {
  let level = thinkingLevel;
  const wrap = h("div", "flex w-full min-w-0 flex-col sm:min-w-72");
  const controls = h("div", "flex flex-col gap-2 border-b border-neutral-200 px-2 py-2");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search models";
  search.setAttribute("aria-label", "Search models");
  search.className =
    "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-[12.5px] focus:border-indigo-400 focus:outline-none";
  controls.append(search);

  if (thinkingLevels.length) {
    const reasoning = document.createElement("details");
    const selected = h("span", "ml-auto font-medium text-indigo-700", thinkingLabel(level));
    const summary = h("summary", "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 text-sm text-neutral-700 hover:bg-neutral-100 [&::-webkit-details-marker]:hidden",
      h("span", "font-medium", "Reasoning effort"), selected, icon(ChevronRight, "chev h-3 w-3 text-neutral-400"));
    const choices = h("fieldset", "grid grid-cols-2 gap-1 rounded-xl bg-neutral-50 p-1");
    choices.append(h("legend", "sr-only", "Reasoning effort"));
    const name = `reasoning-${++reasoningGroup}`;
    for (const l of thinkingLevels) {
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = name;
      radio.value = l;
      radio.checked = l === level;
      radio.className = "peer sr-only";
      radio.onchange = () => {
        if (!radio.checked) return;
        level = l;
        selected.textContent = thinkingLabel(level);
        // A pin can name a reasoning level, so its selected mark changes too.
        renderModels(search.value);
        onThinkingPick(level);
      };
      choices.append(h("label", "relative cursor-pointer",
        radio, h("span", "flex min-h-11 items-center rounded-lg border border-transparent px-3 text-sm text-neutral-700 hover:bg-neutral-100 peer-checked:border-indigo-200 peer-checked:bg-indigo-50 peer-checked:font-semibold peer-checked:text-indigo-700 peer-focus-visible:outline-2 peer-focus-visible:outline-indigo-500", thinkingLabel(l))));
    }
    reasoning.append(summary, choices);
    controls.append(reasoning);
  }

  const listWrap = h("div", "max-h-72 overflow-y-auto py-1");
  /** Only pins naming a model available to this session can be selected. */
  const known = new Map(models.map((m) => [modelKey(m), m]));

  /** Pins without a reasoning level preserve the current selection. */
  const renderPinned = (normalized: string): void => {
    const rows = (pinnedMenu ?? [])
      .map((e) => ({ e, model: known.get(modelKey(e)) }))
      .filter(
        (r): r is { e: Entry; model: ModelRef } =>
          !!r.model && (!normalized || modelKey(r.model).toLowerCase().includes(normalized)),
      );
    if (!rows.length) return;
    listWrap.append(
      h("div", "px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", "Pinned"),
      ...rows.map(({ e, model }) => {
        const thinking = e.thinking ?? level;
        return modelRow({
          label: model.id,
          hint: e.thinking ? thinkingLabel(e.thinking) : undefined,
          title: e.note,
          checked: !!current && modelKey(current) === modelKey(model) && level === thinking,
          onSelect: () => onPick(model, e.thinking),
        });
      }),
      h("div", "my-1 border-t border-neutral-100"),
    );
  };

  const renderModels = (query: string): void => {
    listWrap.replaceChildren();
    const normalized = query.trim().toLowerCase();
    renderPinned(normalized);
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
        icon(ChevronRight, "chev h-3 w-3"),
        h("span", "truncate", provider),
        h("span", "ml-auto flex-none normal-case text-neutral-300", String(list.length)),
      );
      group.append(
        summary,
        ...list.map((m) =>
          modelRow({
            label: m.id,
            checked: !!current && modelKey(current) === modelKey(m),
            onSelect: () => onPick(m),
          }),
        ),
      );
      listWrap.append(group);
    }
  };

  search.oninput = () => renderModels(search.value);
  renderModels("");
  // Rendered from the last known menu, refreshed on every open so an edit in
  // Settings → Models shows up without a page reload. Re-render only on a real
  // change: it would otherwise collapse a group the user just expanded.
  void loadPinned()
    .then((menu) => {
      const changed = JSON.stringify(menu) !== JSON.stringify(pinnedMenu);
      pinnedMenu = menu;
      if (changed) renderModels(search.value);
    })
    .catch((err: unknown) => report("model menu unavailable", err));
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
 * composer's picker: same grouping, same search, same pinned model+reasoning
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
      // A pinned combo carries its own reasoning level; apply both at once.
      onPick: (model, thinking) => {
        closeMenu();
        onChange({ model, thinking: thinking ?? choice.thinking });
      },
      onThinkingPick: (thinking) => {
        choice = { ...choice, thinking };
        onChange(choice);
      },
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
