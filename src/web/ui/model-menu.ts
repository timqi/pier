// Settings → Models: the operator's model menu — the few models this
// deployment actually favors, each with one line of intent ("hardest
// reasoning", "cheap bulk"). Agents read it through the task tool's `models`
// operation, and every picker lists pinned entries first. Empty menu = no
// advice; everything falls back to the curated catalog.
// Design: docs/plans/07-model-menu.md.

import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { h } from "./dom.js";
import { button, card, empty, field, input, select, setStatus } from "./form.js";

interface MenuEntry extends ModelRef {
  thinking?: ThinkingLevel;
  note?: string;
}

const key = (m: ModelRef): string => `${m.provider}/${m.id}`;

/** The intents that keep coming up — offered in the note's dropdown so "what
 * do I write here" has answers to pick from, not just a blank line. */
const NOTE_PRESETS = [
  "hardest reasoning — architecture, gnarly debugging",
  "long autonomous implementation runs",
  "balanced default — implementation, review",
  "cheap & fast — listings, extraction, simple checks",
  "cross-vendor second opinion",
];

export function createModelMenuPane(): { el: HTMLElement; load(): void } {
  let entries: MenuEntry[] = [];
  let catalog: ModelRef[] = [];
  let dirty = false;

  const status = h("span", "text-[11.5px]", "");
  const save = button("Save menu", true);
  const listBox = h("div", "flex min-w-0 flex-col gap-2");
  const adder = h("div", "flex items-center gap-2");
  // w-full alongside max-w: a flex child's min-width would otherwise let an
  // overflowing row widen the card past its column (which is how this page
  // first shipped broken).
  const el = h("div", "mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6");

  function markDirty(): void {
    dirty = true;
    setStatus(status, "idle", "unsaved changes");
  }

  function entryRow(entry: MenuEntry): HTMLElement {
    const note = input(entry.note ?? "");
    note.classList.remove("w-full");
    note.classList.add("min-w-0", "flex-1");
    note.placeholder = "why this one — pick a preset or write your own";
    note.setAttribute("list", "model-menu-notes");
    note.oninput = () => {
      entry.note = note.value;
      markDirty();
    };
    // Advice, not a lock — the agent may still raise or drop it per task.
    const thinking = select(
      [["thinking: model default", ""], ...THINKING_LEVELS.map((l): [string, string] => [`thinking: ${thinkingLabel(l)}`, l])],
      entry.thinking ?? "",
    );
    // The row is a flex line: fixed widths for the two flanks, the note takes
    // the rest. CONTROL's w-full would blow the line apart, so it goes.
    thinking.classList.replace("w-full", "w-44");
    thinking.classList.add("flex-none");
    thinking.onchange = () => {
      if (thinking.value) entry.thinking = thinking.value as ThinkingLevel;
      else delete entry.thinking;
      markDirty();
    };
    const remove = button("Remove");
    remove.classList.add("flex-none");
    remove.onclick = () => {
      entries = entries.filter((e) => e !== entry);
      markDirty();
      render();
    };
    const name = h("span", "w-52 flex-none truncate font-mono text-[12px] text-neutral-700", key(entry));
    name.title = key(entry);
    return h(
      "div",
      "flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-2xs max-md:flex-wrap",
      name,
      thinking,
      note,
      remove,
    );
  }

  function renderAdder(): void {
    const pickable = catalog.filter((m) => !entries.some((e) => key(e) === key(m)));
    const picker = select(pickable.map((m): [string, string] => [key(m), key(m)]), pickable[0] ? key(pickable[0]) : "");
    picker.classList.replace("w-full", "flex-1");
    picker.classList.add("min-w-0");
    const add = button("＋ Pin model");
    add.classList.add("flex-none", "whitespace-nowrap");
    add.disabled = pickable.length === 0;
    add.onclick = () => {
      const picked = pickable.find((m) => key(m) === picker.value);
      if (!picked) return;
      entries.push({ ...picked });
      markDirty();
      render();
    };
    adder.replaceChildren(picker, add);
  }

  function render(): void {
    listBox.replaceChildren(
      ...(entries.length
        ? entries.map(entryRow)
        : [empty("Nothing pinned — every picker shows the curated catalog as is.")]),
    );
    renderAdder();
  }

  async function saveMenu(): Promise<void> {
    setStatus(status, "saving", "saving…");
    const menu = entries.map(({ provider, id, thinking, note }) => ({
      provider,
      id,
      ...(thinking ? { thinking } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
    }));
    const res = await sendJson("/api/settings", { modelMenu: menu }, "PUT");
    if (!res.ok) return setStatus(status, "failed", await failure(res, "Could not save"));
    entries = ((await res.json()) as { modelMenu: MenuEntry[] }).modelMenu;
    dirty = false;
    setStatus(status, "saved", "Saved — agents see it on their next models call.");
    render();
  }
  save.onclick = () => void saveMenu();

  function load(): void {
    if (dirty) return; // an unsaved edit survives tab hops; reload happens on save
    void (async () => {
      const [settingsRes, modelsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/models"),
      ]);
      if (!settingsRes.ok) {
        return setStatus(status, "failed", await failure(settingsRes, "Could not load the menu"));
      }
      entries = ((await settingsRes.json()) as { modelMenu: MenuEntry[] }).modelMenu;
      catalog = modelsRes.ok ? ((await modelsRes.json()) as ModelRef[]) : [];
      status.textContent = "";
      render();
    })();
  }

  const presets = h("datalist", "");
  presets.id = "model-menu-notes";
  presets.append(...NOTE_PRESETS.map((n) => new Option(n)));

  el.append(
    card(
      "Model menu",
      "Which few models this deployment favors, each with a usual reasoning level and one line of intent. " +
        "Pinned entries lead every model picker, and agents delegating work match your notes against the task " +
        "instead of guessing ids.",
      field("Pinned models", listBox, {
        hint: "The note is what an agent matches a task against — say when to reach for it, not what it is.",
      }),
      field("Add", adder, { hint: "The list is the live catalog — only models that exist right now can be pinned." }),
      h("div", "flex items-center gap-3", save, status),
      presets,
    ),
  );

  return { el, load };
}
