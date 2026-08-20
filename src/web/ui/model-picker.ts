// Grouped model list, provider by provider. A standalone component because
// model choice will show up outside chat too (scheduled tasks pick a model).

import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import { h } from "./dom.js";
import { menuItem } from "./menu.js";

export interface ModelPickerProps {
  models: ModelRef[];
  current?: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onPick: (model: ModelRef) => void;
  onThinkingPick: (level: ThinkingLevel) => void;
}

export const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

export function modelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  onPick,
  onThinkingPick,
}: ModelPickerProps): HTMLElement {
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
    for (const level of thinkingLevels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1);
      select.append(option);
    }
    select.value = thinkingLevel;
    select.onchange = () => onThinkingPick(select.value as ThinkingLevel);
    reasoning.append(h("span", "font-medium", "Reasoning"), select);
    controls.append(reasoning);
  }

  const listWrap = h("div", "max-h-72 overflow-y-auto py-1");
  const renderModels = (query: string): void => {
    listWrap.replaceChildren();
    const normalized = query.trim().toLowerCase();
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
      );
      summary.append(
        h("span", "chev", "\u25b6"),
        h("span", "truncate", provider),
        h("span", "ml-auto flex-none normal-case text-neutral-300", String(list.length)),
      );
      group.append(
        summary,
        ...list.map((m) =>
          menuItem({
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
  wrap.append(controls, listWrap);
  queueMicrotask(() => search.focus());
  return wrap;
}
