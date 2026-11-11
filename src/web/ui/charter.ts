// The Charter dialog: editing one chain's `chains/<id>/AGENTS.md`, the user's
// instructions its next head loads (docs/plans/36-chain-charter.md §B2).

import { X } from "lucide";
import { icon } from "./icons.js";
import { getJson, postJson } from "./api.js";
import { h } from "./dom.js";
import { button, CONTROL } from "./form.js";
import { commandKey } from "./shortcut.js";
import { MODAL } from "./system-prompt.js";
import { CHARTER_MAX_CHARS } from "../../core/types.js";
import type { Charter } from "../types.js";

/** Suggested lines, never written to the file: the charter is plain Markdown. */
const PLACEHOLDER = "Focus: …\nDefault repo: …\nSkills: …\nModels: …";

/** Told of every save: the pane says when a head keeps the old charter (main.ts). */
let saved: (chainId: string, head: boolean) => void = () => {};
export const onCharterSaved = (fn: typeof saved): void => {
  saved = fn;
};

export function openCharter(chain: { id: string; name: string }): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Charter");
  dialog.className = MODAL;
  /** The file as last read or saved; null until the read lands, and after a failed one. */
  let stored: string | null = null;
  let saving = false;
  // CONTROL's `text-[12.5px]` is redefined unlayered (style.css) and would beat a phone
  // override: swapped, so iOS gets the ≥ 16px that keeps it from zooming in.
  const size = CONTROL.replace("text-[12.5px]", "text-base md:text-[12.5px]");
  const area = h("textarea", `${size} min-h-0 flex-1 resize-none font-mono leading-5`) as HTMLTextAreaElement;
  area.setAttribute("aria-label", `Charter of ${chain.name}`);
  area.placeholder = PLACEHOLDER;
  area.spellcheck = false;
  area.disabled = true;
  const count = h("span", "mr-auto text-[13px] tabular-nums text-neutral-500");
  const error = h("p", "hidden px-4 pb-2 text-[13px] text-red-600");
  error.setAttribute("role", "alert");
  const cancel = button("Cancel");
  const save = button("Save", true);
  for (const b of [cancel, save]) b.classList.add("max-md:min-h-11");
  const close = h("button", "icon-btn h-11 w-11 sm:h-8 sm:w-8", icon(X));
  close.setAttribute("aria-label", "Close charter");

  const dirty = (): boolean => stored !== null && area.value !== stored;
  const over = (): boolean => area.value.length > CHARTER_MAX_CHARS;
  const paint = (): void => {
    count.textContent = `${String(area.value.length)} / ${String(CHARTER_MAX_CHARS)}`;
    count.classList.toggle("text-red-600", over());
    count.classList.toggle("text-neutral-500", !over());
    save.disabled = saving || !dirty() || over();
  };
  const fail = (text: string): void => {
    error.textContent = text;
    error.classList.remove("hidden");
  };
  /** Unsaved text is not dropped without a yes. */
  const leave = (): void => {
    if (dirty() && !window.confirm(`Discard the unsaved charter of ${chain.name}?`)) return;
    dialog.close();
  };
  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    saving = true;
    paint();
    const got = await postJson<Charter>(`/api/chains/${chain.id}/charter`, { text: area.value }, "Could not save the charter", "PUT");
    saving = false;
    if (!got.ok) {
      fail(got.error);
      return paint();
    }
    stored = got.value.text;
    dialog.close();
    saved(chain.id, got.value.head === true);
  };

  area.oninput = paint;
  area.onkeydown = (ev) => {
    if (ev.key === "Enter" && commandKey(ev)) {
      ev.preventDefault();
      void submit();
    }
  };
  save.onclick = () => void submit();
  cancel.onclick = leave;
  close.onclick = leave;
  // Esc asks as ✕ does, taken at the key: Chrome stops letting `cancel` be
  // refused on a second Esc with no click between, and closes over a "no".
  dialog.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.isComposing) return;
    ev.preventDefault();
    leave();
  });
  // Any other close request (Android's back).
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    leave();
  });
  dialog.onclose = () => dialog.remove();
  dialog.append(
    h("div", "flex items-start gap-2 border-b border-neutral-200 px-4 py-3",
      h("div", "min-w-0 flex-1",
        h("div", "text-sm font-medium text-neutral-500", "Charter"),
        h("h2", "mt-1 [overflow-wrap:anywhere] text-lg leading-7 font-semibold text-neutral-900", chain.name),
        h("div", "mt-0.5 [overflow-wrap:anywhere] text-[13px] text-neutral-500",
          h("span", "font-mono", `chains/${chain.id}/AGENTS.md`), " · read by this chain's main session from its next session")),
      close),
    h("div", "flex min-h-0 flex-1 flex-col px-4 py-3", area),
    error,
    h("div", "flex items-center gap-2 border-t border-neutral-200 px-4 py-2.5", count, cancel, save),
  );
  paint();
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  void getJson<Charter>(`/api/chains/${chain.id}/charter`, "Could not load the charter").then((got) => {
    if (!got.ok) return fail(got.error);
    area.value = got.value.text;
    // As the textarea holds it, line endings normalised: an untouched file is not unsaved.
    stored = area.value;
    area.disabled = false;
    paint();
    if (document.activeElement === close) area.focus();
  });
  return dialog;
}
