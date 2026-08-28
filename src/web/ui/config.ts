// Settings → Agent: one list of everything a session is made of, and one pane
// to act on whichever item is selected — an agent file to edit, a skill or an
// extension to read, a bundled extension to switch on. Three kinds of item,
// one reason to exist: pick a thing on the left, do the one thing it affords on
// the right. Scope comes from the session list (global + each project cwd);
// bundled switches are instance-wide, so they appear under Global only.

import type { CatalogEntry, ConfigResource, ToolsSyncNote } from "../../core/types.js";
import { failure, sendJson } from "./api.js";
import { codePane, plainRows } from "./code.js";
import { basename, consoleView, h, type ConsoleView } from "./dom.js";
import { badge, CONTROL, field, setStatus, textInput, toggle } from "./form.js";
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
  /** One pane for every command-line tool: a row and a switch each, because a
   *  page per binary is four pages saying the same three facts. */
  | { type: "tools" };

/** The one settings answer every switch here is drawn from. */
interface CatalogResponse {
  catalog: CatalogEntry[];
  /** The blocks the operator wrote, as stored — the catalog carries only the
   *  spec line out of each, and re-sending the list takes the whole body. */
  customTools: { name: string; toml: string }[];
  toolsTaskId: string | null;
  /** What became of the install the switch asked for; absent when it asked for
   *  none. */
  toolsSync?: ToolsSyncNote;
}

/** What a save turned out to be, for the status line that redraws with it. */
interface SaveOutcome {
  state: "saved" | "failed";
  text: string;
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
  /** Everything with a switch — bundled extensions and managed binaries in one
   *  list, because rtk is both; [] outside global scope. */
  let catalog: CatalogEntry[] = [];
  /** Why the list is missing, when it is — an empty section would read as
   *  "Pier ships none", which is a different fact. */
  let catalogError = "";
  /** The daily update task, where every install and failure is a run. */
  let toolsTaskId: string | null = null;
  /** The custom blocks, as stored: what a save has to send back unchanged. */
  let customTools: { name: string; toml: string }[] = [];
  const extensionEntries = (): CatalogEntry[] => catalog.filter((e) => e.kind === "extension");
  const toolEntries = (): CatalogEntry[] => catalog.filter((e) => e.kind === "tool");

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
  async function loadCatalog(): Promise<void> {
    if (scope !== "global") {
      catalog = [];
      catalogError = "";
      return;
    }
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) {
      catalog = [];
      catalogError = await failure(res, "could not be loaded");
      return;
    }
    take((await res.json()) as CatalogResponse);
    catalogError = "";
  }

  /** One answer, every list: a switch is never drawn from anything but the
   *  state the server just confirmed. */
  function take(body: CatalogResponse): void {
    catalog = body.catalog;
    customTools = body.customTools;
    toolsTaskId = body.toolsTaskId;
  }

  /**
   * The one write behind every switch here. Which set it lands in follows from
   * the entry: something with a binary is in the tool set, something without is
   * loaded from inside Pier — one rule, so no switch can write both.
   */
  async function save(body: Record<string, unknown>, saved: string): Promise<SaveOutcome> {
    const res = await sendJson("/api/settings", body, "PUT");
    // Redrawn from the state the server last confirmed, so a switch never
    // shows something nobody stored — and the reason rides with the redraw.
    if (!res.ok) return { state: "failed", text: await failure(res, "could not save") };
    const answer = (await res.json()) as CatalogResponse;
    take(answer);
    renderNav(lastIndex); // the `on` badge in the nav is part of the answer
    // Stored — and then what actually became of it. "Saved" while a sync it
    // has to queue behind is still running is how three switches turned into
    // one installed tool with nothing anywhere saying so.
    if (answer.toolsSync?.state === "refused") {
      return { state: "failed", text: `Saved, but nothing will install it: ${answer.toolsSync.reason}` };
    }
    if (answer.toolsSync?.state === "waiting") {
      return { state: "saved", text: "Saved — a sync is already running; this change goes in the run right after it." };
    }
    return { state: "saved", text: saved };
  }

  /** The names one switch leaves behind in its own set. */
  function switchBody(name: string, checked: boolean): Record<string, string[]> {
    const binary = Boolean(catalog.find((e) => e.name === name)?.binary);
    const names = catalog
      .filter((e) => Boolean(e.binary) === binary && (e.name === name ? checked : e.enabled))
      .map((e) => e.name);
    return binary ? { tools: names } : { extensions: names };
  }

  async function load(): Promise<void> {
    const request = ++loadRequest;
    paneRequest++;
    const [res] = await Promise.all([
      fetch(`/api/config${q()}`, { cache: "no-store" }),
      loadCatalog(),
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
      else if (sel.type === "tools") openTools();
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
      if (catalogError) {
        rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-red-600", catalogError));
      } else if (!extensionEntries().length) {
        rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-neutral-400", "none"));
      }
      for (const ext of extensionEntries()) {
        const sel: Selection = { type: "bundled", name: ext.name };
        rows.push(
          navRow(ext.name, isActive(sel), false, () => open(sel), 0, ext.enabled ? onBadge() : undefined),
        );
      }
      // One row, not one per binary: the tools differ by name and version and
      // nothing else, so a page each would say the same three facts four times.
      if (!catalogError) {
        const sel: Selection = { type: "tools" };
        const on = toolEntries().filter((t) => t.enabled).length;
        rows.push(navRow("command-line tools", isActive(sel), false, () => open(sel), 0, on ? onBadge() : undefined));
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

  /** Where every install and every failure already is: the update task's runs.
   *  Null before anything is switched on, because the task does not exist. */
  function taskLink(text: string): HTMLElement | null {
    if (!toolsTaskId) return null;
    const link = h("a", "text-indigo-600 hover:underline", text) as HTMLAnchorElement;
    link.href = `#/tasks/${encodeURIComponent(toolsTaskId)}`;
    return link;
  }

  /** Who actually does the installing. Named and linked because the block
   *  below is written in someone else's config language: a body that ubix
   *  rejects is only debuggable against ubix's own documentation. */
  const ubixLink = (): HTMLElement => {
    const link = h("a", "text-indigo-600 hover:underline", "ubix") as HTMLAnchorElement;
    link.href = "https://github.com/timqi/ubix";
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  };

  /** What a binary is right now, in one line — the same line in both panes. */
  function binaryLine(entry: CatalogEntry): string {
    const binary = entry.binary;
    if (!binary) return "";
    if (binary.error) return `${binary.spec} — ${binary.error}`;
    if (!binary.installed) return `${binary.spec} — not installed`;
    return `${binary.spec} — ${binary.version ?? "unknown version"} at ${binary.path ?? "an unknown path"}`;
  }

  /**
   * The switch, and the things it cannot be understood without: when it takes
   * effect, who wins against a copy of your own, and — for an extension that
   * ships as a command — which binary it is and where the install ran.
   */
  function openBundled(name: string, note?: SaveOutcome): void {
    paneRequest++;
    const ext = catalog.find((e) => e.name === name && e.kind === "extension");
    if (!ext) return renderError(`unknown extension: ${name}`);
    const status = h("span", "text-[11.5px] text-neutral-400", "");
    if (note) setStatus(status, note.state, note.text);
    const runs = taskLink("every run of the update task");
    pane.replaceChildren(
      paneBar(
        ext.name,
        h(
          "span",
          "ml-auto text-[11px] uppercase tracking-wide text-neutral-400",
          ext.binary ? "installed by Pier" : "ships with Pier",
        ),
      ),
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
          ...(ext.adds ?? []).flatMap((tool) => [
            h("dt", "font-mono text-[12px] text-neutral-700", tool.name),
            h("dd", "text-[12px] leading-snug text-neutral-500", `needs ${tool.needs}`),
          ]),
          ...(ext.binary
            ? [
              h("dt", "font-mono text-[12px] text-neutral-700", "binary"),
              h(
                "dd",
                `font-mono text-[12px] leading-snug ${ext.binary.error ? "text-red-600" : "text-neutral-500"}`,
                binaryLine(ext),
              ),
            ]
            : []),
        ),
        toggle(
          "Enabled",
          ext.binary
            ? "Installed into Pier's own bin directory, first on the PATH every session, task and terminal "
              + "inherits; it registers its own Pi extension. Switching it off uninstalls both."
            : "Loaded from inside Pier — nothing is installed and no update touches your own extensions. "
              + "A session mid-turn keeps the tools it started with; the next message picks this up.",
          ext.enabled,
          (checked) => void flip(ext.name, checked, (outcome) => openBundled(name, outcome)),
        ),
        h(
          "p",
          "max-w-2xl text-[12px] leading-snug text-neutral-400",
          ...(ext.binary
            ? runs ? ["A daily task installs and updates it — its history is ", runs, "."] : ["Switching it on creates the daily task that installs it."]
            : ["An extension of your own that registers the same tool wins: this copy stands down and says so in the log."]),
        ),
        status,
      ),
    );
  }

  /**
   * Every command-line tool in one pane: a row, a line and a switch each, plus
   * the operator's own specs. No page per binary — they differ by name and
   * version, and a page each would repeat the same three facts.
   */
  function openTools(note?: SaveOutcome, draft = { name: "", toml: "" }): void {
    paneRequest++;
    const status = h("span", "text-[11.5px] text-neutral-400", "");
    if (note) setStatus(status, note.state, note.text);
    const tools = toolEntries();
    // Every binary that is on, not only the ones in this pane: rtk is switched
    // by the same set from its own pane, and rewriting the set without it
    // would uninstall it behind the operator's back.
    const enabledBinaries = (): string[] => catalog.filter((e) => e.binary && e.enabled).map((e) => e.name);
    const runs = taskLink("the update task");

    const row = (tool: CatalogEntry): HTMLElement => {
      const line = h(
        "div",
        "flex min-w-0 flex-1 flex-col gap-0.5",
        h(
          "span",
          "flex items-center gap-2 text-[13px] text-neutral-700",
          h("span", "font-mono", tool.name),
          ...(tool.custom ? [badge("yours", "bg-neutral-50 text-neutral-500 ring-neutral-200")] : []),
        ),
        h("span", "text-[11.5px] leading-snug text-neutral-400", tool.summary || binaryLine(tool)),
        ...(tool.summary
          ? [h(
            "span",
            `font-mono text-[11px] leading-snug ${tool.binary?.error ? "text-red-600" : "text-neutral-400"}`,
            binaryLine(tool),
          )]
          : []),
      );
      const box = toggle("", "", tool.enabled, (checked) => void flip(tool.name, checked, (outcome) => openTools(outcome)));
      const remove = h("button", "btn text-[12px] text-neutral-500 hover:text-red-600", "Remove") as HTMLButtonElement;
      remove.onclick = () => {
        remove.disabled = true;
        void save(
          {
            customTools: customTools.filter((c) => c.name !== tool.name),
            tools: enabledBinaries().filter((n) => n !== tool.name),
          },
          `Removed ${tool.name} — the next run uninstalls it.`,
        ).then((outcome) => openTools(outcome));
      };
      return h(
        "div",
        "flex max-w-2xl items-start gap-3 border-b border-neutral-100 py-2.5 last:border-0",
        line,
        ...(tool.custom ? [remove] : []),
        box,
      );
    };

    // Adding one is declaring it *and* switching it on: nobody writes a block
    // in order to leave it off, and the switch beside it undoes half of that.
    const typed = { ...draft };
    // The header is Pier's and the body is theirs — shown, so it is obvious
    // what is being written into rather than something to guess at.
    const header = h("span", "font-mono text-[12px] text-neutral-500", "[tools.<name>]");
    const nameField = textInput(typed.name, "claude", (v) => {
      typed.name = v;
      header.textContent = `[tools.${v.trim() || "<name>"}]`;
    }, true);
    const bodyField = document.createElement("textarea");
    bodyField.className = `${CONTROL} h-24 resize-y font-mono leading-snug`;
    bodyField.spellcheck = false;
    bodyField.value = typed.toml;
    bodyField.placeholder = `spec = "github:owner/repo"\nexe = "tool"`;
    bodyField.oninput = () => (typed.toml = bodyField.value);
    const add = h("button", "btn btn-primary text-[12.5px]", "Add") as HTMLButtonElement;
    add.onclick = () => {
      const entry = { name: typed.name.trim(), toml: typed.toml.trim() };
      if (!entry.name || !entry.toml) {
        return setStatus(status, "failed", "A custom tool needs a name and a block with a spec line.");
      }
      add.disabled = true;
      void save(
        { customTools: [...customTools, entry], tools: [...enabledBinaries(), entry.name] },
        `Added ${entry.name} — installing now.`,
      ).then((outcome) =>
        // A refused block is redrawn with what was typed still in the fields:
        // the fix is one line, and retyping the rest is not part of it.
        openTools(outcome, outcome.state === "failed" ? typed : undefined)
      );
    };

    pane.replaceChildren(
      paneBar(
        "command-line tools",
        h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "installed by Pier"),
      ),
      h(
        "div",
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
        h(
          "p",
          "max-w-2xl text-[13px] leading-relaxed text-neutral-600",
          "Installed into Pier's own bin directory and put first on the PATH every session, task and terminal "
            + "inherits — so an agent gets this copy, at this version, whatever the machine already has.",
        ),
        h(
          "p",
          "max-w-2xl text-[12.5px] leading-relaxed text-neutral-500",
          "Pier writes no downloader: ",
          ubixLink(),
          " does the work — a declarative installer that resolves a spec like ",
          h("span", "font-mono text-[11.5px]", "github:owner/repo"),
          " to the right release asset for this machine, verifies it, and upgrades in place. Pier bootstraps it, "
            + "generates its config from the switches below, and keeps its files under Pier's own directory — "
            + "your own ubix setup is untouched.",
        ),
        catalogError
          ? h("p", "max-w-2xl text-[12.5px] text-red-600", catalogError)
          : h("div", "flex max-w-2xl flex-col", ...tools.map(row)),
        h(
          "div",
          "flex max-w-2xl flex-col gap-2 border-t border-neutral-200 pt-4",
          h("span", "text-[12.5px] font-medium text-neutral-600", "Add one of your own"),
          field("Name", nameField),
          field("The block Pier writes under the header", bodyField, {
            hint: "Any keys ubix takes — spec, matching, exe, exes, rename, tag, version, the url: templating "
              + "keys. Pier writes the header and leaves the body alone; a line that opens a section of its own "
              + "is refused, because it could rewrite the rest of the file.",
          }),
          h("div", "flex items-center gap-3", header, add),
          h(
            "span",
            "text-[11.5px] leading-snug text-neutral-400",
            "github: and url: install on their own. npm: and pypi: need ubix's own runtime (fnm / uv) and land "
              + "in that runtime's prefix, not Pier's bin — the row says so when they do.",
          ),
        ),
        h(
          "p",
          "max-w-2xl text-[12px] leading-snug text-neutral-400",
          ...(runs ? ["Installs and daily updates run as ", runs, " — output, failures and all."] : ["Switching one on creates the daily task that installs it and keeps it current."]),
        ),
        status,
      ),
    );
  }

  /** One switch, flipped: write the set it belongs to, then redraw the pane it
   *  was flipped in with what came back. */
  async function flip(name: string, checked: boolean, redraw: (outcome: SaveOutcome) => void): Promise<void> {
    const entry = catalog.find((e) => e.name === name);
    redraw(await save(
      switchBody(name, checked),
      entry?.binary
        ? checked ? "Saved — installing now; watch the run." : "Saved — uninstalling in the next run."
        : "Saved — sessions take it on their next message.",
    ));
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
