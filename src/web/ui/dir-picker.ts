// Working-directory picker, shared by every surface that asks for a path: the
// New-session menu, the IM channel config and the Files view's root chip.
// Two shared parts: the folder tree, and the menu of paths the
// surface can already name with the tree one row below it. Where a form owns
// the path they decorate its text input rather than replacing it, so form
// semantics (required, validation) stay where they are and typing still works.
//
// Inside the panel the path line is an input for the same reason: clicking
// down from home is the slow way to reach a directory the person can already
// name.

import { Plus } from "lucide";
import { icon } from "./icons.js";
import { getJson, sendJson } from "./api.js";
import { h } from "./dom.js";
import { btn } from "./form.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";

interface Listing {
  path: string;
  parent: string | null;
  entries: { name: string; dir: boolean }[];
}

/** Absolute paths only; anything else means "start from the user's home". */
const listing = async (path?: string): Promise<Listing | null> => {
  const q = path?.startsWith("/") ? `?path=${encodeURIComponent(path)}` : "";
  const got = await getJson<Listing>(`/api/fs/ls${q}`, "Could not list directories");
  return got.ok ? got.value : null;
};

/** What a project picker offers: folders, and not the dot ones — they are
 *  noise here, and a hidden cwd can still be typed into the path line. The
 *  listing itself is the Files view's too, so the filtering is this caller's. */
const folders = (list: Listing): string[] =>
  list.entries.filter((e) => e.dir && !e.name.startsWith(".")).map((e) => e.name);

/** One row of the tree, in the action menu's own shape (menu.ts): the panel
 *  it sits in is a menu, so its rows read and hit like menu rows. */
const ROW = "flex w-full min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-indigo-50 hover:text-indigo-700 active:bg-indigo-100";
/** Path line, error line, "New folder" field: the shared 0.875rem mono. */
const MONO = "font-mono text-[0.875rem]";

const row = (label: string, cls: string, onSelect: () => void): HTMLElement => {
  const el = btn(label, `${ROW} ${cls}`);
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
  const box = h("div", "mt-2 flex-none border-t border-neutral-200 pt-2");
  const start = row("New folder", "text-neutral-500", () => {
    const input = document.createElement("input");
    input.className = `w-full rounded-xl border-0 bg-neutral-100 px-3 py-2 ${MONO} focus:outline-none`;
    input.placeholder = "folder-name";
    const error = h("p", "hidden px-3 pt-1 text-[0.8125rem] text-red-600");
    input.onkeydown = async (ev) => {
      // Escape is handled by the panel itself (menu.ts). Enter must not reach
      // an enclosing form (the channel config's), which would submit it.
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const res = await sendJson("/api/fs/mkdir", { path: parent, name: input.value });
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
  start.prepend(icon(Plus));
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
    // Fills a sheet; a fixed width on desktop so walking the tree does not
    // resize the panel under the pointer.
    const content = h("div", "flex max-h-[60dvh] w-full flex-col sm:w-88");
    const use = btn("Use", "btn btn-primary ml-auto flex-none px-3 py-1 text-[0.8125rem]");
    use.onclick = () => commit(list.path);
    // The path is typed as often as it is clicked to — a directory nobody has a
    // session in is several clicks from home and one paste from anywhere — so
    // the line that names where you are is the line you can edit. Enter takes
    // it, once the server confirms it is a folder this can read.
    const typed = document.createElement("input");
    typed.className = `min-w-0 flex-1 border-0 bg-transparent ${MONO} text-neutral-600 focus:outline-none`;
    typed.value = list.path;
    typed.spellcheck = false;
    typed.title = "Type or paste a path, then Enter";
    typed.onfocus = () => typed.select();
    const error = h("p", "hidden flex-none px-3 pb-1 text-[0.8125rem] text-red-600");
    typed.onkeydown = async (ev) => {
      // Escape belongs to the panel (menu.ts). Enter must not reach an
      // enclosing form (the channel config's), which would submit it.
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
      "mb-2 flex flex-none items-center gap-2 border-b border-neutral-200 px-3 pb-2 pt-1",
      typed,
      use,
    );
    const body = h("div", "min-h-0 flex-1 overflow-y-auto");
    if (list.parent) body.append(row("../", `${MONO} text-neutral-500`, () => void open(list.parent!)));
    const names = folders(list);
    for (const name of names) {
      body.append(row(name, "truncate", () => void open(`${list.path}/${name}`.replace("//", "/"))));
    }
    if (!names.length) body.append(h("p", "px-3 py-2 text-[0.8125rem] text-neutral-400", "No sub-folders."));
    // Creating navigates into the new folder, so "Use" is one click away.
    content.append(head, error, body, newFolderRow(list.path, (path) => void open(path)));
    openPanel(anchor, content);
  }

  void open(start);
}

/** A folder this surface already knows about, offered before the full tree. */
export interface PathOption {
  path: string;
  hint?: string;
}

/**
 * The paths a surface can name, then the tree for everything else. Every
 * picker that has candidates shows them the same way — the Files view's
 * worktrees and the New-session menu's projects are the same question — so
 * the menu lives here rather than once per caller.
 */
export function openPathMenu(
  anchor: HTMLElement,
  options: PathOption[],
  current: string | undefined,
  onPick: (path: string) => void,
): void {
  openMenu(anchor, [
    ...options.map((o) => ({
      label: o.path,
      ...(o.hint ? { hint: o.hint } : {}),
      checked: o.path === current,
      onSelect: () => {
        closeMenu();
        onPick(o.path);
      },
    })),
    { label: "Browse…", onSelect: () => openBrowser(anchor, current || undefined, onPick) },
  ]);
}

/** Writes a picked path into a field the way a typing user would. */
const writer =
  (input: HTMLInputElement, onPick?: (path: string) => void) =>
  (path: string): void => {
    input.value = path;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onPick?.(path);
  };

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
  button.onclick = () => openBrowser(button, input.value.trim() || undefined, writer(input, onPick));
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
