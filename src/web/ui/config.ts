// Settings → Agent files: scoped Pi config editing (whitelisted files) plus
// read-only extension/skill browsing. A pure consumer of /api/config; scope
// choices come from the session list (global + each project cwd).

import type { ConfigResource } from "../../core/types.js";
import { failure, sendJson } from "./api.js";
import { basename, consoleView, h, type ConsoleView } from "./dom.js";
import { setStatus } from "./form.js";

interface ConfigIndex {
  dir: string;
  files: { name: string; exists: boolean }[];
  resources: { extensions: ConfigResource[]; skills: ConfigResource[] };
}

type Selection =
  | { type: "file"; name: string }
  | { type: "resource"; kind: "extensions" | "skills"; name: string };

export function createConfigView(root: HTMLElement, getCwds: () => string[]): ConsoleView {
  let scope = "global";
  let selection: Selection | null = null;
  let loadRequest = 0;
  let paneRequest = 0;
  // Where "Global" lives, from the API — PIER_HOME moves it, so no path is
  // hardcoded here. Empty until the first load answers.
  let globalDir = "";

  // --- static skeleton: header + (scope select ▸ nav) | pane -----------------

  // Scope sits at the top of the nav, right above the files it switches.
  const scopeSelect = document.createElement("select");
  scopeSelect.className =
    "select w-full rounded-md border border-neutral-300 px-2 py-1 text-[12.5px] focus:border-indigo-400 focus:outline-none";
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

  // No header of its own: embedded under Settings → Agent files, whose strip
  // already names it.
  const navList = h("div", "min-h-0 flex-1 overflow-y-auto py-1");
  const nav = h("nav", "flex w-64 flex-none flex-col border-r border-neutral-200 text-[13px]");
  nav.append(scopeBox, navList);
  const pane = h("div", "flex min-w-0 flex-1 flex-col");
  const body = h("div", "flex min-h-0 flex-1");
  body.append(nav, pane);
  root.append(body);

  // --- data -------------------------------------------------------------------

  const q = (extra = ""): string => `?scope=${encodeURIComponent(scope)}${extra}`;

  async function load(): Promise<void> {
    const request = ++loadRequest;
    paneRequest++;
    const res = await fetch(`/api/config${q()}`, { cache: "no-store" });
    if (request !== loadRequest) return;
    if (!res.ok) {
      renderNav(null);
      renderError(`failed to load config: ${res.status}`);
      return;
    }
    const index = (await res.json()) as ConfigIndex;
    if (request !== loadRequest) return;
    if (scope === "global" && index.dir) {
      globalDir = index.dir;
      renderScopeOptions();
    }
    renderNav(index);
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
    const rows: HTMLElement[] = [];
    rows.push(navSection("Files"));
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

  /** The pane's title bar: file name plus whatever the mode adds. */
  const paneBar = (name: string, ...rest: HTMLElement[]): HTMLElement =>
    h(
      "div",
      "flex flex-none items-center gap-3 border-b border-neutral-200 px-4 py-2",
      h("span", "font-mono text-[12.5px] text-neutral-500", name),
      ...rest,
    );

  async function openFile(name: string): Promise<void> {
    const request = ++paneRequest;
    const res = await fetch(`/api/config/files/${encodeURIComponent(name)}${q()}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      if (request === paneRequest) renderError(`failed to load ${name}: ${res.status}`);
      return;
    }
    const { content } = (await res.json()) as { content: string };
    if (request !== paneRequest) return;
    let expected = content;

    const status = h("span", "text-[11.5px] text-neutral-400", "");
    const save = h("button", "btn btn-primary ml-auto text-[12.5px]", "Save") as HTMLButtonElement;
    const editor = document.createElement("textarea");
    editor.className =
      "block min-h-0 flex-1 resize-none bg-white p-4 font-mono text-[13px] leading-relaxed focus:outline-none";
    editor.spellcheck = false;
    editor.value = content;

    const doSave = async (): Promise<void> => {
      if (save.disabled) return;
      const submitted = editor.value;
      save.disabled = true;
      setStatus(status, "saving", "saving…");
      try {
        const put = await sendJson(
          `/api/config/files/${encodeURIComponent(name)}${q()}`,
          { content: submitted, expected },
          "PUT",
        );
        if (!put.ok) return setStatus(status, "failed", await failure(put, "save failed"));
        const saved = (await put.json()) as { content: string };
        expected = saved.content;
        if (editor.value === submitted) {
          editor.value = saved.content;
          setStatus(status, "saved", "saved — applies to new sessions");
        } else setStatus(status, "idle", "saved; newer changes are unsaved");
      } catch (err) {
        setStatus(status, "failed", `save failed: ${String(err)}`);
      } finally {
        save.disabled = false;
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
      setStatus(status, "idle", "unsaved changes");
    };

    pane.replaceChildren(paneBar(name, status, save), editor);
    editor.focus();
  }

  async function openResource(kind: "extensions" | "skills", name: string): Promise<void> {
    const request = ++paneRequest;
    const res = await fetch(
      `/api/config/resource${q(`&kind=${kind}&name=${encodeURIComponent(name)}`)}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      if (request === paneRequest) renderError(`failed to load ${name}: ${res.status}`);
      return;
    }
    const { content } = (await res.json()) as { content: string };
    if (request !== paneRequest) return;
    pane.replaceChildren(
      paneBar(name, h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "read-only")),
      h("pre", "min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12.5px]", content),
    );
  }

  function renderScopeOptions(): void {
    scopeSelect.replaceChildren(
      new Option(globalDir ? `Global (${globalDir})` : "Global", "global"),
      ...getCwds().map((cwd) => new Option(`${basename(cwd)} — ${cwd}`, cwd)),
    );
    if (![...scopeSelect.options].some((o) => o.value === scope)) scope = "global";
    scopeSelect.value = scope;
  }

  return consoleView(root, () => {
    renderScopeOptions();
    void load();
  });
}
