// Console → Configuration view: scoped Pi config editing (whitelisted files)
// plus read-only extension/skill browsing. A pure consumer of /api/config;
// scope choices come from the session list (global + each project cwd).

import type { ConfigResource } from "../../core/types.js";
import { h } from "./dom.js";

interface ConfigIndex {
  files: { name: string; exists: boolean }[];
  resources: { extensions: ConfigResource[]; skills: ConfigResource[] };
}

type Selection =
  | { type: "file"; name: string }
  | { type: "resource"; kind: "extensions" | "skills"; name: string };

export interface ConfigView {
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

export function createConfigView(root: HTMLElement, getCwds: () => string[]): ConfigView {
  let scope = "global";
  let selection: Selection | null = null;
  let visible = false;

  // --- static skeleton: header + (scope select ▸ nav) | pane -----------------

  // Scope sits at the top of the nav, right above the files it switches.
  const scopeSelect = document.createElement("select");
  scopeSelect.className =
    "w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12.5px] focus:border-indigo-400 focus:outline-none";
  scopeSelect.onchange = () => {
    scope = scopeSelect.value;
    selection = null;
    openDirs.clear();
    void load();
  };
  const scopeBox = h("div", "flex flex-none flex-col gap-1 border-b border-neutral-200 px-3 pb-2.5 pt-2");
  scopeBox.append(
    h("span", "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", "Scope"),
    scopeSelect,
  );

  const header = h("header", "flex h-10 flex-none items-center gap-3 border-b border-neutral-200 px-4");
  header.append(h("span", "font-medium", "Configuration"));
  const navList = h("div", "min-h-0 flex-1 overflow-y-auto py-1");
  const nav = h("nav", "flex w-64 flex-none flex-col border-r border-neutral-200 text-[13px]");
  nav.append(scopeBox, navList);
  const pane = h("div", "flex min-w-0 flex-1 flex-col");
  const body = h("div", "flex min-h-0 flex-1");
  body.append(nav, pane);
  root.append(header, body);

  // --- data -------------------------------------------------------------------

  const q = (extra = ""): string => `?scope=${encodeURIComponent(scope)}${extra}`;

  async function load(): Promise<void> {
    const res = await fetch(`/api/config${q()}`);
    if (!res.ok) {
      renderNav(null);
      renderError(`failed to load config: ${res.status}`);
      return;
    }
    renderNav((await res.json()) as ConfigIndex);
    if (!selection) renderPlaceholder();
  }

  // --- nav ---------------------------------------------------------------------

  function navSection(title: string): HTMLElement {
    return h("div", "px-3 pb-0.5 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", title);
  }

  /** Symlinked resources are real config, just stored elsewhere — say so. */
  const linkBadge = (): HTMLElement => {
    const badge = h(
      "span",
      "flex-none rounded bg-neutral-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500",
      "link",
    );
    badge.title = "Reached through a symlink";
    return badge;
  };

  function navRow(
    label: string,
    active: boolean,
    dim: boolean,
    onPick: () => void,
    depth = 0,
    link = false,
  ): HTMLElement {
    const row = h(
      "button",
      `flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 text-left hover:bg-neutral-100 ${
        active ? "bg-indigo-50 hover:bg-indigo-50" : ""
      } ${dim ? "text-neutral-400" : ""}`,
    );
    row.append(h("span", "truncate", label));
    if (link) row.append(linkBadge());
    row.style.paddingLeft = `${20 + depth * 14}px`;
    row.title = label;
    row.onclick = onPick;
    return row;
  }

  // --- resource folder tree (folders collapsed by default) ---------------------

  interface Tree {
    files: ConfigResource[];
    dirs: Map<string, Tree>;
    /** A folder is a link when everything under it came through one. */
    link: boolean;
  }

  function buildTree(resources: ConfigResource[]): Tree {
    const root: Tree = { files: [], dirs: new Map(), link: true };
    for (const res of resources) {
      const parts = res.name.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) {
        let next = node.dirs.get(dir);
        if (!next) node.dirs.set(dir, (next = { files: [], dirs: new Map(), link: true }));
        next.link &&= res.link;
        node = next;
      }
      node.files.push({ name: parts[parts.length - 1]!, link: res.link });
    }
    return root;
  }

  /** Folder open/close state survives re-renders; cleared on scope change. */
  const openDirs = new Set<string>();

  function renderTree(
    kind: "extensions" | "skills",
    tree: Tree,
    prefix: string,
    depth: number,
    isActive: (sel: Selection) => boolean,
    open: (sel: Selection) => void,
  ): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const [dir, sub] of tree.dirs) {
      const path = prefix ? `${prefix}/${dir}` : dir;
      const key = `${kind}:${path}`;
      const el = document.createElement("details");
      el.open = openDirs.has(key);
      el.ontoggle = () => (el.open ? openDirs.add(key) : openDirs.delete(key));
      const summary = h("summary", "flex cursor-pointer select-none items-center gap-1 truncate py-1 pr-3 hover:bg-neutral-100");
      summary.style.paddingLeft = `${20 + depth * 14}px`;
      summary.title = path;
      summary.append(h("span", "chev", "▶"), h("span", "truncate text-neutral-600", dir));
      if (sub.link) summary.append(linkBadge());
      el.append(summary, ...renderTree(kind, sub, path, depth + 1, isActive, open));
      rows.push(el);
    }
    for (const file of tree.files) {
      const name = prefix ? `${prefix}/${file.name}` : file.name;
      const sel: Selection = { type: "resource", kind, name };
      rows.push(navRow(file.name, isActive(sel), false, () => open(sel), depth, file.link));
    }
    return rows;
  }

  function renderNav(index: ConfigIndex | null): void {
    if (!index) {
      navList.replaceChildren();
      return;
    }
    const isActive = (sel: Selection): boolean => JSON.stringify(sel) === JSON.stringify(selection);
    const open = (sel: Selection): void => {
      selection = sel;
      renderNav(index); // re-highlight
      if (sel.type === "file") void openFile(sel.name);
      else void openResource(sel.kind, sel.name);
    };
    const rows: HTMLElement[] = [navSection("Files")];
    for (const f of index.files) {
      const sel: Selection = { type: "file", name: f.name };
      rows.push(navRow(f.name, isActive(sel), !f.exists, () => open(sel)));
    }
    for (const kind of ["extensions", "skills"] as const) {
      rows.push(navSection(`${kind} (read-only)`));
      const items = index.resources[kind];
      if (!items.length) rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-neutral-400", "none"));
      rows.push(...renderTree(kind, buildTree(items), "", 0, isActive, open));
    }
    navList.replaceChildren(...rows);
  }

  // --- pane --------------------------------------------------------------------

  function renderPlaceholder(): void {
    pane.replaceChildren(
      h("p", "px-4 py-3 text-[13px] text-neutral-400", "Select a file to edit, or browse extensions and skills."),
    );
  }

  function renderError(message: string): void {
    pane.replaceChildren(h("p", "px-4 py-3 text-[13px] text-red-600", message));
  }

  async function openFile(name: string): Promise<void> {
    const res = await fetch(`/api/config/files/${encodeURIComponent(name)}${q()}`);
    if (!res.ok) return renderError(`failed to load ${name}: ${res.status}`);
    const { content } = (await res.json()) as { content: string };

    const status = h("span", "text-[12px] text-neutral-400", "");
    const save = h("button", "btn btn-primary ml-auto text-[12.5px]", "Save");
    const editor = document.createElement("textarea");
    editor.className =
      "block min-h-0 flex-1 resize-none bg-white p-4 font-mono text-[13px] leading-relaxed focus:outline-none";
    editor.spellcheck = false;
    editor.value = content;

    const doSave = async (): Promise<void> => {
      status.textContent = "saving…";
      const put = await fetch(`/api/config/files/${encodeURIComponent(name)}${q()}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: editor.value }),
      });
      if (put.ok) {
        status.className = "text-[12px] text-green-700";
        status.textContent = "saved — applies to new sessions";
      } else {
        status.className = "text-[12px] text-red-600";
        status.textContent = `save failed: ${((await put.json()) as { error?: string }).error ?? put.status}`;
      }
    };
    save.onclick = () => void doSave();
    editor.onkeydown = (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
        ev.preventDefault();
        void doSave();
      }
    };
    editor.oninput = () => {
      status.className = "text-[12px] text-neutral-400";
      status.textContent = "unsaved changes";
    };

    const bar = h("div", "flex flex-none items-center gap-3 border-b border-neutral-200 px-4 py-2");
    bar.append(h("span", "font-mono text-[12.5px] text-neutral-500", name), status, save);
    pane.replaceChildren(bar, editor);
    editor.focus();
  }

  async function openResource(kind: "extensions" | "skills", name: string): Promise<void> {
    const res = await fetch(`/api/config/resource${q(`&kind=${kind}&name=${encodeURIComponent(name)}`)}`);
    if (!res.ok) return renderError(`failed to load ${name}: ${res.status}`);
    const { content } = (await res.json()) as { content: string };
    const bar = h("div", "flex flex-none items-center gap-3 border-b border-neutral-200 px-4 py-2");
    bar.append(
      h("span", "font-mono text-[12.5px] text-neutral-500", name),
      h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "read-only"),
    );
    pane.replaceChildren(
      bar,
      h("pre", "min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12.5px]", content),
    );
  }

  // --- visibility ----------------------------------------------------------------

  return {
    get visible() {
      return visible;
    },
    show() {
      visible = true;
      root.classList.remove("hidden");
      root.classList.add("flex");
      const cwds = getCwds();
      scopeSelect.replaceChildren(
        new Option("Global (~/.pi/agent)", "global"),
        ...cwds.map((cwd) => new Option(`${basename(cwd)} — ${cwd}`, cwd)),
      );
      if (![...scopeSelect.options].some((o) => o.value === scope)) scope = "global";
      scopeSelect.value = scope;
      void load();
    },
    hide() {
      visible = false;
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
  };
}
