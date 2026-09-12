// Settings → Models: the operator's pinned menu, matched by `pier task
// --model` and listed first in every picker, the model every new session
// starts on, and the title model Pier itself calls.

import { ChevronDown, ChevronUp, Plus, type IconNode } from "lucide";
import { icon } from "./icons.js";
import { THINKING_LEVELS, type AgentDefaults, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { failure, getJson, sendJson } from "./api.js";
import { h } from "./dom.js";
import { btn, button, card, CONTROL_TRIGGER, empty, field, input, select, setStatus } from "./form.js";
import { closeMenu, openPanel } from "./menu.js";
import { launchField, modelPicker, type LaunchChoice } from "./model-picker.js";

interface MenuEntry extends ModelRef {
  thinking: ThinkingLevel;
  note?: string;
}

/** What a pin is set to when the operator pins one without saying — the same
 *  level every other surface falls back to. */
const DEFAULT_THINKING: ThinkingLevel = "medium";

const key = (m: ModelRef): string => `${m.provider}/${m.id}`;

const asChoice = (d: AgentDefaults): LaunchChoice => ({ model: d.defaultModel, thinking: d.defaultThinkingLevel });

/** What no title model means, on the trigger and on the row that clears it. */
const TITLE_OFF = "Off — the first message is the title";

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
  let titleModel: ModelRef | undefined;
  let defaults: LaunchChoice = { model: null, thinking: null };
  // A move redraws the list, so the arrow that was pressed has to be handed
  // its focus back or a keyboard walk up the list ends after one step.
  let focusAfter: { at: string; step: -1 | 1 } | null = null;

  const status = h("span", "text-[11.5px]", "");
  const titleStatus = h("span", "text-[11.5px]", "");
  const titleBox = h("div", "flex items-center gap-3");
  const defaultStatus = h("span", "text-[11.5px]", "");
  const defaultBox = h("div", "flex flex-col gap-1.5");
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

  /** Order is what the menu says beyond each line: pickers list it as stored
   *  and `pier task --model ?` prints it in that order, so first pin reads as
   *  first choice. Arrows, not drag: they work on a thumb and on a keyboard. */
  function moveButton(entry: MenuEntry, step: -1 | 1, glyph: IconNode, label: string): HTMLButtonElement {
    const at = entries.indexOf(entry);
    const to = at + step;
    const el = btn("", "icon-btn max-md:h-11 max-md:w-11 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent");
    el.append(icon(glyph));
    el.title = label;
    el.setAttribute("aria-label", `${label}: ${key(entry)}`);
    el.disabled = to < 0 || to >= entries.length;
    el.onclick = () => {
      entries.splice(to, 0, ...entries.splice(at, 1));
      focusAfter = { at: key(entry), step };
      markDirty();
      render();
    };
    return el;
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
      THINKING_LEVELS.map((l): [string, string] => [`thinking: ${thinkingLabel(l)}`, l]),
      entry.thinking,
    );
    // The row is a flex line: fixed widths for the two flanks, the note takes
    // the rest. CONTROL's w-full would blow the line apart, so it goes.
    thinking.classList.replace("w-full", "w-44");
    thinking.classList.add("flex-none");
    thinking.onchange = () => {
      entry.thinking = thinking.value as ThinkingLevel;
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
    const up = moveButton(entry, -1, ChevronUp, "Move up");
    const down = moveButton(entry, 1, ChevronDown, "Move down");
    if (focusAfter?.at === key(entry)) {
      // At an end that arrow is disabled; the focus goes to the way back.
      const [moved, back] = focusAfter.step === -1 ? [up, down] : [down, up];
      focusAfter = null;
      queueMicrotask(() => (moved.disabled ? back : moved).focus());
    }
    return h(
      "div",
      "flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-2xs max-md:flex-wrap",
      h("span", "flex flex-none items-center", up, down),
      name,
      thinking,
      note,
      remove,
    );
  }

  /** Picking is the pinning, level and all: a pin has a reasoning level from
   *  the moment it exists. */
  function renderAdder(): void {
    const pickable = catalog.filter((m) => !entries.some((e) => key(e) === key(m)));
    const add = button("Pin model");
    add.prepend(icon(Plus));
    add.classList.add("inline-flex", "items-center", "gap-1.5", "flex-none", "whitespace-nowrap");
    add.disabled = pickable.length === 0;
    add.onclick = () => {
      let thinking = DEFAULT_THINKING;
      openPanel(add, modelPicker({
        models: pickable,
        current: null,
        thinkingLevel: thinking,
        thinkingLevels: [...THINKING_LEVELS],
        onThinkingPick: (level) => {
          thinking = level;
        },
        // No pinned row can be picked here — what is pinned is not offered —
        // so the level is always the selector's.
        onPick: (model) => {
          closeMenu();
          entries.push({ provider: model.provider, id: model.id, thinking });
          markDirty();
          render();
        },
      }));
    };
    adder.replaceChildren(add);
  }

  /** The chat composer's picker, written on pick — no save button: a model
   *  chosen here has no second field to fill in and nothing to be dirty
   *  against. No reasoning level either; a title is one short request. */
  function renderTitleModel(): void {
    // The stored model stays listed when the catalog no longer has it: the row
    // must say what is set, and the failing call says the rest.
    const stored = titleModel;
    const options = stored && !catalog.some((m) => key(m) === key(stored)) ? [stored, ...catalog] : catalog;
    const open = btn(
      stored ? stored.id : TITLE_OFF,
      `${CONTROL_TRIGGER} flex min-w-0 flex-1 items-center ${stored ? "text-neutral-700" : "text-neutral-400"}`,
    );
    if (stored) open.title = key(stored);

    const save = (picked: ModelRef | null): void => {
      closeMenu();
      void (async () => {
        setStatus(titleStatus, "saving", "saving…");
        const res = await sendJson("/api/settings", { titleModel: picked && { provider: picked.provider, id: picked.id } }, "PUT");
        if (!res.ok) {
          setStatus(titleStatus, "failed", await failure(res, "Could not save"));
          return renderTitleModel(); // back to what is stored
        }
        titleModel = ((await res.json()) as { titleModel?: ModelRef }).titleModel;
        setStatus(titleStatus, "saved", titleModel ? "Saved — names the next new session after its first reply." : "Off.");
        renderTitleModel();
      })();
    };

    open.onclick = () => {
      const panel = modelPicker({
        models: options,
        current: stored,
        // No levels, so the picker draws no reasoning selector and neither of
        // these two is ever read: a title is one short request.
        thinkingLevel: "medium",
        thinkingLevels: [],
        onThinkingPick: () => {},
        onPick: save,
      });
      const off = btn(TITLE_OFF, "w-full cursor-pointer px-3 py-1.5 text-left text-[12.5px] text-neutral-500 hover:bg-neutral-100");
      off.onclick = () => save(null);
      const wrap = h("div", "flex flex-col");
      wrap.append(panel, h("div", "border-t border-neutral-200"), off);
      openPanel(open, wrap);
    };
    titleBox.replaceChildren(open, titleStatus);
  }

  /** The launch picker, written on change like the title model: what is shown
   *  is always what settings.json holds, redrawn from the server's answer. */
  function renderDefaults(): void {
    defaultBox.replaceChildren(
      launchField("Default model", defaults, catalog, (next) => void saveDefaults(next)),
      defaultStatus,
    );
  }

  async function saveDefaults(next: LaunchChoice): Promise<void> {
    setStatus(defaultStatus, "saving", "saving…");
    const res = await sendJson(
      "/api/config/defaults",
      { defaultModel: next.model, defaultThinkingLevel: next.thinking },
      "PUT",
    );
    if (!res.ok) {
      setStatus(defaultStatus, "failed", await failure(res, "Could not save"));
      return renderDefaults(); // back to what is stored
    }
    defaults = asChoice((await res.json()) as AgentDefaults);
    setStatus(
      defaultStatus,
      "saved",
      defaults.model || defaults.thinking ? "Saved — the next new session starts on it." : "Pi default.",
    );
    renderDefaults();
  }

  function render(): void {
    listBox.replaceChildren(
      ...(entries.length
        ? entries.map(entryRow)
        : [empty("Nothing pinned — every picker shows the curated catalog as is.")]),
    );
    renderAdder();
    renderDefaults();
    renderTitleModel();
  }

  async function saveMenu(): Promise<void> {
    setStatus(status, "saving", "saving…");
    const menu = entries.map(({ provider, id, thinking, note }) => ({
      provider,
      id,
      thinking,
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
      const [settings, models, stored] = await Promise.all([
        getJson<{ modelMenu: MenuEntry[]; titleModel?: ModelRef }>("/api/settings", "Could not load the menu"),
        getJson<ModelRef[]>("/api/models", "Could not load the model catalog"),
        getJson<AgentDefaults>("/api/config/defaults", "Could not read the default model"),
      ]);
      if (!settings.ok) return setStatus(status, "failed", settings.error);
      entries = settings.value.modelMenu;
      titleModel = settings.value.titleModel;
      catalog = models.ok ? models.value : [];
      if (stored.ok) {
        defaults = asChoice(stored.value);
        defaultStatus.textContent = "";
      } else setStatus(defaultStatus, "failed", stored.error);
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
        hint: "The note is what an agent matches a task against — say when to reach for it, not what it is, "
          + "and keep every note distinct: two pins reading alike are refused as ambiguous. The arrows set the "
          + "order pickers and `pier task --model ?` list.",
      }),
      field("Add", adder, { hint: "The list is the live catalog — only models that exist right now can be pinned." }),
      h("div", "flex items-center gap-3", save, status),
      presets,
    ),
    card(
      "New sessions",
      "The model and reasoning effort a session starts on when nothing names one — a channel, chat or task with " +
        "its own launch choice overrides it. Pi default leaves the pick to Pi. Stored in settings.json; applies to sessions opened from now on.",
      defaultBox,
    ),
    card(
      "Session titles",
      "A session is titled by its first message unless a model names it: one short request after the first " +
        "reply, on the model picked here — a small, cheap one is plenty. A failed request is reported in the session and the first message stays the title.",
      field("Title model", titleBox),
    ),
  );

  return { el, load };
}
