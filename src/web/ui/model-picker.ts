// Grouped model list, provider by provider. A standalone component because
// model choice will show up outside chat too (scheduled tasks pick a model).

import type { ModelRef } from "../../core/types.js";
import { h } from "./dom.js";
import { menuItem } from "./menu.js";

export interface ModelPickerProps {
  models: ModelRef[];
  current?: ModelRef | null;
  onPick: (model: ModelRef) => void;
}

export const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

export function modelPicker({ models, current, onPick }: ModelPickerProps): HTMLElement {
  const wrap = h("div", "max-h-80 overflow-y-auto");
  const groups = new Map<string, ModelRef[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  if (!groups.size) {
    wrap.append(h("div", "px-3 py-2 text-[12.5px] text-neutral-400", "No models available."));
    return wrap;
  }
  // Groups start collapsed — only the provider in use is open, so picking a
  // model is two clicks instead of a scroll through every catalog.
  for (const [provider, list] of groups) {
    const holdsCurrent = list.some((m) => !!current && modelKey(current) === modelKey(m));
    const group = document.createElement("details");
    group.open = holdsCurrent;
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
    wrap.append(group);
  }
  return wrap;
}
