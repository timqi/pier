// Working-directory picker, shared by every surface that asks for a path: the
// new-session dialog, the IM channel config and the Files view's root chip.
// The panel is the shared part; `browseButton` decorates an existing text
// input rather than replacing it, so form semantics (required, datalist of
// known projects) stay where they are and typing a path still works.
//
// Inside the panel the path line is an input for the same reason: clicking
// down from home is the slow way to reach a directory the person can already
// name.

import { sendJson } from "./api.js";
import { h } from "./dom.js";
import { btn } from "./form.js";
import { closeMenu, openPanel } from "./menu.js";

interface Listing {
  path: string;
  parent: string | null;
  entries: string[];
}

/** Absolute paths only; anything else means "start from the user's home". */
const listing = async (path?: string): Promise<Listing | null> => {
  const q = path?.startsWith("/") ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/dirs${q}`);
  return res.ok ? ((await res.json()) as Listing) : null;
};

const row = (label: string, cls: string, onSelect: () => void): HTMLElement => {
  const el = btn(label, `flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left ${cls}`);
  el.onclick = onSelect;
  return el;
};

/**
 * "New folder" affordance: a new project usually means a directory that does
 * not exist yet, and sending the user to a terminal for `mkdir` is the kind of
 * gap that makes a picker useless. Resolves to the created path, or null when
 * the user backed out or the server refused.
 */
function newFolderRow(parent: string, onCreated: (path: string) => void): HTMLElement {
  const box = h("div", "flex-none border-t border-neutral-200");
  const start = row("+ New folder", "text-[12px] text-neutral-500 hover:bg-neutral-100", () => {
    const input = document.createElement("input");
    input.className =
      "w-full border-0 bg-transparent px-3 py-1 font-mono text-[12.5px] focus:outline-none";
    input.placeholder = "folder-name";
    const error = h("p", "hidden px-3 pb-1 text-[11.5px] text-red-600");
    input.onkeydown = async (ev) => {
      // Escape is handled by the panel itself (menu.ts). Enter must not reach
      // the enclosing form — in the New session dialog that would submit it.
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const res = await sendJson("/api/fs/dirs", { path: parent, name: input.value });
      if (!res.ok) {
        error.textContent = ((await res.json()) as { error?: string }).error ?? "could not create";
        error.classList.remove("hidden");
        return;
      }
      onCreated(((await res.json()) as { path: string }).path);
    };
    box.replaceChildren(input, error);
    input.focus();
  });
  box.append(start);
  return box;
}

/**
 * The folder list itself, anchored under `anchor` and starting at `start`
 * (the user's home when it is not an absolute path). Picking a folder closes
 * the panel and hands the path to `onPick`.
 */
export function openBrowser(
  anchor: HTMLElement,
  start: string | undefined,
  onPick: (path: string) => void,
): void {
  const commit = (path: string): void => {
    onPick(path);
    closeMenu();
  };

  async function open(path?: string): Promise<void> {
    const list = await listing(path);
    if (!list) return;
    const content = h("div", "flex max-h-80 w-80 flex-col");
    const use = btn("Use", "ml-auto flex-none cursor-pointer rounded bg-indigo-600 px-2 py-0.5 text-[11.5px] text-white dark:text-neutral-50");
    use.onclick = () => commit(list.path);
    // The path is typed as often as it is clicked to — a directory nobody has a
    // session in is several clicks from home and one paste from anywhere — so
    // the line that names where you are is the line you can edit. Enter takes
    // it, once the server confirms it is a folder this can read.
    const typed = document.createElement("input");
    typed.className =
      "min-w-0 flex-1 border-0 bg-transparent font-mono text-[11.5px] text-neutral-500 focus:outline-none";
    typed.value = list.path;
    typed.spellcheck = false;
    typed.title = "Type or paste a path, then Enter";
    typed.onfocus = () => typed.select();
    const error = h("p", "hidden flex-none px-3 pb-1 text-[11.5px] text-red-600");
    typed.onkeydown = async (ev) => {
      // Escape belongs to the panel (menu.ts). Enter must not reach an
      // enclosing form — in the New session dialog that would submit it.
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      ev.stopPropagation();
      const want = typed.value.trim();
      if (!want) return;
      const found = await listing(want);
      if (!found) {
        error.textContent = `${want} is not a folder this can read`;
        error.classList.remove("hidden");
        return;
      }
      commit(found.path); // the server's spelling of it, not the one typed
    };
    const head = h(
      "div",
      "flex flex-none items-center gap-2 border-b border-neutral-200 px-3 py-1.5",
      typed,
      use,
    );
    const body = h("div", "min-h-0 flex-1 overflow-y-auto py-0.5 text-[12.5px]");
    if (list.parent) body.append(row("../", "font-mono text-neutral-500 hover:bg-neutral-100", () => void open(list.parent!)));
    for (const name of list.entries) {
      body.append(row(name, "truncate hover:bg-neutral-100", () => void open(`${list.path}/${name}`.replace("//", "/"))));
    }
    if (!list.entries.length) body.append(h("p", "px-3 py-1.5 text-[12px] text-neutral-400", "No sub-folders."));
    // Creating navigates into the new folder, so "Use" is one click away.
    content.append(head, error, body, newFolderRow(list.path, (path) => void open(path)));
    openPanel(anchor, content);
  }

  void open(start);
}

/**
 * A "Browse…" button for a path input. Picking a folder writes it into the
 * input and fires `onPick`, so an optimistic caller can mark itself dirty
 * without listening to input events.
 */
export function browseButton(input: HTMLInputElement, onPick?: (path: string) => void): HTMLElement {
  const button = btn(
    "Browse…",
    "flex-none cursor-pointer rounded-md border border-neutral-300 px-2 py-1 text-[12px] text-neutral-600 hover:bg-neutral-100",
  );
  // Start where the field points, falling back to the user's home directory.
  button.onclick = () =>
    openBrowser(button, input.value.trim() || undefined, (path) => {
      input.value = path;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      onPick?.(path);
    });
  return button;
}

/** Input + Browse button as one row, for surfaces building fields in code. */
export function dirInput(
  value: string,
  placeholder: string,
  onChange: (v: string) => void,
): { el: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.className =
    "min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-[12.5px] focus:border-indigo-400 focus:outline-none";
  input.value = value;
  input.placeholder = placeholder;
  input.oninput = () => onChange(input.value);
  return { el: h("div", "flex items-center gap-1.5", input, browseButton(input, onChange)), input };
}
