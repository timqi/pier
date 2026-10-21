// The rail: a row per Pier instance. Every action is a shell command, every state a `state` event from it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

let hideToast = 0;
function fail(error: unknown): void {
  toast.textContent = String(error);
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

function rename(row: Row, name: HTMLElement): void {
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
      li.draggable = true;
      const dot = el("span", "dot");
      if (row.accent) dot.style.background = row.accent;
      const name = el("span", "name", row.name);
      const remove = el("button", "remove", "×");
      remove.title = "Remove";
      li.append(dot, name, el("span", "unread", row.unread ? String(row.unread) : ""), remove);
      li.onclick = () => {
        if (!editing) void call("select", { id: row.id });
      };
      name.ondblclick = () => rename(row, name);
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

function openAdd(): void {
  form.hidden = false;
  input.focus();
}
document.querySelector<HTMLButtonElement>("#plus")!.onclick = openAdd;
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

await listen<Row[]>("state", (e) => render(e.payload));
await listen<string>("error", (e) => fail(e.payload));
await listen("add", openAdd);
await call("list", {});
