// The tab bar, which is also the title bar: a tab per Pier instance. Every action is a shell
// command, every state a `state` event from it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Row {
  id: string;
  name: string;
  url: string;
  unread: number;
  accent: string | null;
  active: boolean;
}

// index.html is this file's own markup.
const list = document.querySelector<HTMLUListElement>("#instances")!;
const form = document.querySelector<HTMLFormElement>("#add")!;
const input = document.querySelector<HTMLInputElement>("#add input")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const button = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`#${id}`)!;

// macOS keeps its own traffic lights at the bar's left end; elsewhere the bar draws the buttons.
if (navigator.userAgent.includes("Mac")) document.documentElement.dataset.os = "mac";

let hideToast = 0;
function fail(error: unknown): void {
  toast.textContent = toast.title = String(error);
  toast.hidden = false;
  clearTimeout(hideToast);
  hideToast = window.setTimeout(() => (toast.hidden = true), 8000);
}
const call = (command: string, args: Record<string, unknown>): Promise<void> =>
  invoke<void>(command, args).catch(fail);

// A state that arrives mid-rename waits, or it would wipe the edit.
let editing = false;
let pending: Row[] | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

function rename(row: Pick<Row, "id" | "name">, name: HTMLElement): void {
  editing = true;
  name.contentEditable = "plaintext-only";
  name.focus();
  getSelection()?.selectAllChildren(name);
  name.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      name.blur();
    }
    if (e.key === "Escape") {
      name.textContent = row.name;
      name.blur();
    }
  };
  name.onblur = () => {
    editing = false;
    name.removeAttribute("contenteditable");
    const next = name.textContent?.trim() ?? "";
    if (next !== row.name) void call("rename", { id: row.id, name: next });
    if (pending) render(pending);
  };
}

function render(rows: Row[]): void {
  if (editing) {
    pending = rows;
    return;
  }
  pending = null;
  list.replaceChildren(
    ...rows.map((row, index) => {
      const li = el("li", row.active ? "active" : "");
      li.title = row.url;
      li.dataset.id = row.id;
      li.dataset.name = row.name;
      li.role = "tab";
      li.ariaSelected = String(row.active);
      li.draggable = true;
      const dot = el("span", "dot");
      if (row.accent) dot.style.background = row.accent;
      const name = el("span", "name", row.name);
      const remove = el("button", "remove", "×");
      remove.title = "Remove";
      li.append(dot, name, el("span", "unread", row.unread ? String(row.unread) : ""), remove);
      li.onclick = (e) => {
        // Selecting focuses the instance's page, which would end the rename a double click's second click starts.
        if (!editing && e.detail === 1) void call("select", { id: row.id });
      };
      remove.onclick = (e) => {
        e.stopPropagation();
        if (li.classList.contains("confirm")) return void call("remove", { id: row.id });
        li.classList.add("confirm");
        remove.textContent = "Remove";
      };
      li.onmouseleave = () => {
        li.classList.remove("confirm");
        remove.textContent = "×";
      };
      li.ondragstart = (e) => e.dataTransfer?.setData("text/plain", row.id);
      li.ondragover = (e) => e.preventDefault();
      li.ondrop = (e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/plain");
        if (id && id !== row.id) void call("reorder", { id, to: index });
      };
      return li;
    }),
  );
}

// On the list, which outlives a render: the first click's `select` re-renders every tab.
list.ondblclick = (e) => {
  const name = (e.target as Element).closest<HTMLElement>(".name");
  const { id, name: was } = name?.closest("li")?.dataset ?? {};
  if (name && id && was !== undefined) rename({ id, name: was }, name);
};

function openAdd(): void {
  form.hidden = false;
  input.focus();
}
button("plus").onclick = openAdd;
input.onkeydown = (e) => {
  if (e.key === "Escape") form.hidden = true;
};
form.onsubmit = (e) => {
  e.preventDefault();
  invoke("add", { input: input.value }).then(() => {
    form.hidden = true;
    input.value = "";
  }, fail);
};

toast.onclick = () => (toast.hidden = true);
const win = getCurrentWindow();
button("minimize").onclick = () => win.minimize().catch(fail);
button("maximize").onclick = () => win.toggleMaximize().catch(fail);
button("close").onclick = () => win.close().catch(fail);

// The bar's empty space moves the window. The drag starts on the first move, not the press:
// GTK's move grab would swallow a double click's second press.
let pressed = false;
document.body.onmousedown = (e) => {
  if (e.button !== 0 || (e.target as Element).closest("li, button, form, #toast")) return;
  if (e.detail === 2) void win.toggleMaximize().catch(fail);
  pressed = e.detail === 1;
};
document.body.onmousemove = (e) => {
  if (!pressed || e.buttons !== 1) return;
  pressed = false;
  void win.startDragging().catch(fail);
};
document.body.onmouseup = () => (pressed = false);
button("menu").onclick = (e) => {
  const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void call("popup", { x: at.left, y: at.bottom });
};

await listen<Row[]>("state", (e) => render(e.payload));
await listen<string>("error", (e) => fail(e.payload));
await listen("add", openAdd);
await call("list", {});
