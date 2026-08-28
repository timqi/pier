// Settings → Agent: one list of everything a session is made of, and one pane
// to act on whichever item is selected — an agent file to edit, a skill or an
// extension to read, a bundled extension to switch on. Three kinds of item,
// one reason to exist: pick a thing on the left, do the one thing it affords on
// the right. Scope comes from the session list (global + each project cwd);
// bundled switches are instance-wide, so they appear under Global only.

import type { BundledExtensionInfo, ConfigResource, ManagedToolInfo } from "../../core/types.js";
import { failure, sendJson } from "./api.js";
import { codePane, plainRows } from "./code.js";
import { basename, consoleView, h, type ConsoleView } from "./dom.js";
import { setStatus, toggle } from "./form.js";
import { langFor } from "./highlight.js";

interface ConfigIndex {
  dir: string;
  files: { name: string; exists: boolean }[];
  resources: { extensions: ConfigResource[]; skills: ConfigResource[] };
}

type Selection =
  | { type: "file"; name: string }
  | { type: "resource"; kind: "extensions" | "skills"; name: string }
  | { type: "bundled"; name: string }
  | { type: "tool"; name: string };

/** The one settings answer both switch lists are drawn from. */
interface CatalogResponse {
  extensionCatalog: BundledExtensionInfo[];
  toolCatalog: ManagedToolInfo[];
  toolsTaskId: string | null;
}

export function createConfigView(root: HTMLElement, getCwds: () => string[]): ConsoleView {
  let scope = "global";
  let selection: Selection | null = null;
  let loadRequest = 0;
  let paneRequest = 0;
  // Where "Global" lives, from the API — PIER_HOME moves it, so no path is
  // hardcoded here. Empty until the first load answers.
  let globalDir = "";
  /** What the nav is currently drawn from, so a switch can redraw its badge
   *  without re-reading the scope's files. */
  let lastIndex: ConfigIndex | null = null;
  /** The bundled extensions and their switch state; [] outside global scope. */
  let bundled: BundledExtensionInfo[] = [];
  /** Why the list is missing, when it is — an empty section would read as
   *  "Pier ships none", which is a different fact. */
  let bundledError = "";
  /** The managed CLI tools and what is installed today; [] outside global. */
  let managed: ManagedToolInfo[] = [];
  /** The daily update task, where every install and failure is a run. */
  let toolsTaskId: string | null = null;

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

  /** Instance-wide, and the Console already serves them beside the setting. */
  async function loadBundled(): Promise<void> {
    if (scope !== "global") {
      bundled = [];
      managed = [];
      bundledError = "";
      return;
    }
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) {
      bundled = [];
      managed = [];
      bundledError = await failure(res, "could not be loaded");
      return;
    }
    takeCatalogs((await res.json()) as CatalogResponse);
    bundledError = "";
  }

  /** One answer, both lists: a switch is never drawn from anything but the
   *  state the server just confirmed. */
  function takeCatalogs(body: CatalogResponse): void {
    bundled = body.extensionCatalog;
    managed = body.toolCatalog;
    toolsTaskId = body.toolsTaskId;
  }

  async function load(): Promise<void> {
    const request = ++loadRequest;
    paneRequest++;
    const [res] = await Promise.all([
      fetch(`/api/config${q()}`, { cache: "no-store" }),
      loadBundled(),
    ]);
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
    lastIndex = index;
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

  /** A switch that is on, said in the nav so the list can be scanned. */
  const onBadge = (): HTMLElement =>
    h(
      "span",
      "flex-none rounded bg-emerald-50 px-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700",
      "on",
    );

  function navRow(
    label: string,
    active: boolean,
    dim: boolean,
    onPick: () => void,
    depth = 0,
    /** `linkBadge()` or `onBadge()` — one way to mark a row, not two. */
    tag?: HTMLElement,
  ): HTMLElement {
    const row = h(
      "button",
      `flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 text-left hover:bg-neutral-100 ${
        active ? "bg-indigo-50 hover:bg-indigo-50" : ""
      } ${dim ? "text-neutral-400" : ""}`,
    );
    row.append(h("span", "truncate", label));
    if (tag) row.append(tag);
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
      rows.push(
        navRow(file.name, isActive(sel), false, () => open(sel), depth, file.link ? linkBadge() : undefined),
      );
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
      else if (sel.type === "bundled") openBundled(sel.name);
      else if (sel.type === "tool") openTool(sel.name);
      else void openResource(sel.kind, sel.name);
    };
    const rows: HTMLElement[] = [];
    rows.push(navSection("Files"));
    for (const f of index.files) {
      const sel: Selection = { type: "file", name: f.name };
      rows.push(navRow(f.name, isActive(sel), !f.exists, () => open(sel)));
    }
    if (scope === "global") {
      rows.push(navSection("bundled with Pier"));
      if (bundledError) {
        rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-red-600", bundledError));
      } else if (!bundled.length) {
        rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-neutral-400", "none"));
      }
      for (const ext of bundled) {
        const sel: Selection = { type: "bundled", name: ext.name };
        rows.push(
          navRow(ext.name, isActive(sel), false, () => open(sel), 0, ext.enabled ? onBadge() : undefined),
        );
      }
      rows.push(navSection("command-line tools"));
      if (!managed.length && !bundledError) {
        rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-neutral-400", "none"));
      }
      for (const tool of managed) {
        const sel: Selection = { type: "tool", name: tool.name };
        rows.push(
          navRow(tool.name, isActive(sel), false, () => open(sel), 0, tool.enabled ? onBadge() : undefined),
        );
      }
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

  /**
   * The switch, and the two things it cannot be understood without: when it
   * takes effect, and who wins against a copy of your own.
   */
  function openBundled(name: string, note?: { state: "saved" | "failed"; text: string }): void {
    paneRequest++;
    const ext = bundled.find((e) => e.name === name);
    if (!ext) return renderError(`unknown extension: ${name}`);
    const status = h("span", "text-[11.5px] text-neutral-400", "");
    if (note) setStatus(status, note.state, note.text);
    pane.replaceChildren(
      paneBar(ext.name, h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "ships with Pier")),
      h(
        "div",
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
        h("p", "max-w-2xl text-[13px] leading-relaxed text-neutral-600", ext.summary),
        // What the switch actually adds, and what each tool needs to work:
        // "which providers" has no single answer for a whole extension, and
        // finding out from a failed turn is finding out too late.
        h(
          "dl",
          "flex max-w-2xl flex-col gap-1.5",
          ...ext.tools.flatMap((tool) => [
            h("dt", "font-mono text-[12px] text-neutral-700", tool.name),
            h("dd", "text-[12px] leading-snug text-neutral-500", `needs ${tool.needs}`),
          ]),
        ),
        toggle(
          "Enabled",
          "Loaded from inside Pier — nothing is installed and no update touches your own extensions. "
            + "A session mid-turn keeps the tools it started with; the next message picks this up.",
          ext.enabled,
          (checked) => void saveBundled(ext.name, checked),
        ),
        h(
          "p",
          "max-w-2xl text-[12px] leading-snug text-neutral-400",
          "An extension of your own that registers the same tool wins: this copy stands down and says so in the log.",
        ),
        status,
      ),
    );
  }

  async function saveBundled(name: string, checked: boolean): Promise<void> {
    const names = bundled.filter((e) => (e.name === name ? checked : e.enabled)).map((e) => e.name);
    const res = await sendJson("/api/settings", { extensions: names }, "PUT");
    if (!res.ok) {
      // Redrawn from the state the server last confirmed, so the switch never
      // shows something nobody stored — and the reason rides with the redraw.
      return openBundled(name, { state: "failed", text: await failure(res, "could not save") });
    }
    takeCatalogs((await res.json()) as CatalogResponse);
    renderNav(lastIndex); // the `on` badge in the nav is part of the answer
    openBundled(name, { state: "saved", text: "Saved — sessions take it on their next message." });
  }

  /**
   * The switch, what it installed, and where the install can be watched. No
   * status of its own: the daily task's runs are the record, so the pane
   * points at them instead of inventing a second one.
   */
  function openTool(name: string, note?: { state: "saved" | "failed"; text: string }): void {
    paneRequest++;
    const tool = managed.find((t) => t.name === name);
    if (!tool) return renderError(`unknown tool: ${name}`);
    const status = h("span", "text-[11.5px] text-neutral-400", "");
    if (note) setStatus(status, note.state, note.text);
    const facts: HTMLElement[] = [
      h("dt", "font-mono text-[12px] text-neutral-700", "spec"),
      h("dd", "font-mono text-[12px] leading-snug text-neutral-500", tool.spec),
      h("dt", "font-mono text-[12px] text-neutral-700", "installed"),
      h(
        "dd",
        "font-mono text-[12px] leading-snug text-neutral-500",
        tool.installed ? `${tool.version ?? "unknown version"} — ${tool.path ?? "path unknown"}` : "not installed",
      ),
    ];
    // What is wrong with it, where the version would be: a tool ubix records
    // and the disk no longer has is broken, not ready.
    const runs = toolsTaskId
      ? h("a", "text-indigo-600 hover:underline", "every run of the update task")
      : null;
    if (runs) (runs as HTMLAnchorElement).href = `#/tasks/${encodeURIComponent(toolsTaskId ?? "")}`;
    pane.replaceChildren(
      paneBar(tool.name, h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "managed by Pier")),
      h(
        "div",
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
        h("p", "max-w-2xl text-[13px] leading-relaxed text-neutral-600", tool.summary),
        h("dl", "flex max-w-2xl flex-col gap-1.5", ...facts),
        ...(tool.error ? [h("p", "max-w-2xl text-[12px] leading-snug text-red-600", tool.error)] : []),
        toggle(
          "Enabled",
          "Installed into Pier's own bin directory, first on the PATH every session, task and terminal inherits. "
            + "Switching it off uninstalls it again.",
          tool.enabled,
          (checked) => void saveTools(tool.name, checked),
        ),
        h(
          "p",
          "max-w-2xl text-[12px] leading-snug text-neutral-400",
          ...(runs
            ? ["A daily task installs and updates it — its history is ", runs, "."]
            : ["Switching one on creates the daily task that installs it and keeps it current."]),
        ),
        status,
      ),
    );
  }

  async function saveTools(name: string, checked: boolean): Promise<void> {
    const names = managed.filter((t) => (t.name === name ? checked : t.enabled)).map((t) => t.name);
    const res = await sendJson("/api/settings", { tools: names }, "PUT");
    if (!res.ok) {
      // Same contract as the bundled switch: redraw from what the server last
      // confirmed, with the reason it refused.
      return openTool(name, { state: "failed", text: await failure(res, "could not save") });
    }
    takeCatalogs((await res.json()) as CatalogResponse);
    renderNav(lastIndex);
    openTool(name, {
      state: "saved",
      text: checked ? "Saved — installing now; watch the run." : "Saved — uninstalling in the next run.",
    });
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
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop(); // the trailing newline is not a line
    // The Files view's renderer, not a second one: same gutter, same
    // highlighting, same wrapping — a skill or an extension is source code,
    // and it was reading as a wall of grey <pre>.
    pane.replaceChildren(
      paneBar(name, h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "read-only")),
      h("div", "min-h-0 flex-1 overflow-auto", codePane(plainRows(lines), langFor(name))),
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
