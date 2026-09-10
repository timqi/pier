// Settings → Agent: one list of everything a session is made of, and one pane
// to act on the selected item. The agent files and the command-line tools are
// drawn here; the package registry's panes are packages-pane.ts.

import type { CatalogEntry, ConfigFile } from "../../core/types.js";
// Type-only, erased at build: web's own wire vocabulary (architecture.md).
import type { ToolsSyncNote } from "../types.js";
import { failure, getJson, sendJson } from "./api.js";
import { codePane, fileRows } from "./code.js";
import { basename, consoleView, h, type ConsoleView } from "./dom.js";
import { badge, btn, CONTROL, empty, field, PANEL, PANEL_HEAD, setStatus, textInput, toggle } from "./form.js";
import { langFor } from "./highlight.js";
import { configSyncPane } from "./config-sync.js";
import { createRegistry, packageLabel, type RegistrySelection } from "./packages-pane.js";

/** Agent's two panes: the shared panel surface, clipped to its own radius
 *  because each pane scrolls inside it. */
const PANE = `${PANEL} flex flex-col overflow-hidden`;
/** Their title bands — the nav's scope picker, the pane's file name. */
const BAND = `${PANEL_HEAD} flex flex-none items-center`;

interface ConfigIndex {
  dir: string;
  files: ConfigFile[];
}

type Selection =
  | { type: "file"; name: string; readonly: boolean }
  /** One pane for every command-line tool: a row and a switch each, because a
   *  page per binary is four pages saying the same three facts. */
  | { type: "tools" }
  | { type: "sync" }
  | RegistrySelection;

/** The one settings answer every tool switch is drawn from. */
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

/** A write that never landed is a failed outcome with `answer` absent, so the
 *  caller redraws from the state the server last confirmed (§5). */
export async function writeSettings(
  body: Record<string, unknown>,
  saved: string,
): Promise<{ outcome: SaveOutcome; answer?: CatalogResponse }> {
  let res: Response;
  try {
    res = await sendJson("/api/settings", body, "PUT");
  } catch (err) {
    return { outcome: { state: "failed", text: `Could not save: ${String(err)}` } };
  }
  if (!res.ok) return { outcome: { state: "failed", text: await failure(res, "could not save") } };
  let answer: CatalogResponse;
  try {
    answer = (await res.json()) as CatalogResponse;
  } catch (err) {
    // Stored, and unreadable: saying "saved" here would leave the page drawing
    // a state it never got back.
    return { outcome: { state: "failed", text: `Saved, but the answer could not be read: ${String(err)}` } };
  }
  // "Saved" is not what became of it while a sync is still queued.
  if (answer.toolsSync?.state === "refused") {
    return { outcome: { state: "failed", text: `Saved, but nothing will install it: ${answer.toolsSync.reason}` }, answer };
  }
  if (answer.toolsSync?.state === "waiting") {
    return {
      outcome: { state: "saved", text: "Saved — a sync is already running; this change goes in the run right after it." },
      answer,
    };
  }
  return { outcome: { state: "saved", text: saved }, answer };
}

/** Switch off first, so the next sync uninstalls the binary; drop the
 *  declaration second, or nothing is left that can remove it. When the block
 *  may go is the server's rule (web/instance.ts); the pane shows its sentence. */
export function removalStep(
  entry: CatalogEntry,
  customTools: readonly { name: string; toml: string }[],
): { body: Record<string, unknown>; saved: string } {
  if (entry.enabled) {
    return {
      body: { tool: { name: entry.name, on: false } },
      saved: `Switched ${entry.name} off — the next run uninstalls it. Remove it again once its binary is gone.`,
    };
  }
  return {
    body: { customTools: customTools.filter((tool) => tool.name !== entry.name) },
    saved: `Removed ${entry.name}.`,
  };
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
  /** The managed binaries; [] outside global scope. */
  let catalog: CatalogEntry[] = [];
  /** Why the list is missing, when it is — an empty section would read as
   *  "Pier ships none", which is a different fact. */
  let catalogError = "";
  /** The daily update task, where every install and failure is a run. */
  let toolsTaskId: string | null = null;
  let syncPane: ReturnType<typeof configSyncPane> | null = null;
  const closeSync = (): void => { syncPane?.dispose(); syncPane = null; };
  const openSync = (): void => {
    closeSync();
    ++paneRequest;
    syncPane = configSyncPane();
    pane.replaceChildren(syncPane.el);
  };
  /** The custom blocks, as stored: what a save has to send back unchanged. */
  let customTools: { name: string; toml: string }[] = [];
  /** A row the operator wrote, and may remove again. */
  const isCustom = (entry: CatalogEntry): boolean => entry.custom === true;
  /** rtk is a binary too, but its row is the `pier` package's. */
  const toolEntries = (): CatalogEntry[] => catalog.filter((e) => e.kind === "tool");

  // --- static skeleton: header + (scope select ▸ nav) | pane -----------------

  // Scope sits at the top of the nav, right above the files it switches — in
  // the Console's one control skin, not a smaller select of its own.
  const scopeSelect = document.createElement("select");
  scopeSelect.className = `${CONTROL} select`;
  scopeSelect.onchange = () => {
    closeSync();
    scope = scopeSelect.value;
    selection = null;
    void load();
  };
  const scopeBox = h("div", `${BAND} flex-col items-stretch gap-1.5 px-3 py-2.5`);
  scopeBox.append(h("span", "field-label", "Scope"), scopeSelect);

  const navList = h("div", "min-h-0 flex-1 overflow-y-auto py-1.5");
  const nav = h("nav", `${PANE} w-64 flex-none text-[13px] leading-5 max-md:max-h-48 max-md:w-full`);
  nav.append(scopeBox, navList);
  const pane = h("div", `${PANE} min-w-0 flex-1`);
  const body = h("div", "flex min-h-0 flex-1 gap-3 px-4 pb-4 pt-1 max-md:flex-col");
  body.append(nav, pane);
  root.append(body);

  /** The pane's title bar: file name plus whatever the mode adds. */
  const paneBar = (name: string, ...rest: HTMLElement[]): HTMLElement =>
    h(
      "div",
      `${BAND} flex-wrap gap-3 px-4 py-2.5`,
      h("span", "font-mono text-[12.5px] text-neutral-500", name),
      ...rest,
    );

  const registry = createRegistry({
    pane,
    paneBar,
    claim: () => ++paneRequest,
    live: (ticket) => ticket === paneRequest,
    cwd: () => (scope === "global" ? undefined : scope),
    changed: () => renderNav(lastIndex),
    select: (sel) => {
      selection = sel;
      renderNav(lastIndex);
    },
  });

  // --- data -------------------------------------------------------------------

  const q = (extra = ""): string => `?scope=${encodeURIComponent(scope)}${extra}`;

  /** Instance-wide, and the Console already serves them beside the setting. */
  async function loadCatalog(): Promise<void> {
    if (scope !== "global") {
      catalog = [];
      catalogError = "";
      return;
    }
    const got = await getJson<CatalogResponse>("/api/settings", "could not be loaded", {
      cache: "no-store",
    });
    if (!got.ok) {
      catalog = [];
      catalogError = got.error;
      return;
    }
    take(got.value);
    catalogError = "";
  }

  /** One answer, every list: a switch is never drawn from anything but the
   *  state the server just confirmed. */
  function take(body: CatalogResponse): void {
    catalog = body.catalog;
    customTools = body.customTools;
    toolsTaskId = body.toolsTaskId;
  }

  /** Redraws from the state the server confirmed, so a switch never shows
   *  something nobody stored. */
  async function save(body: Record<string, unknown>, saved: string): Promise<SaveOutcome> {
    const { outcome, answer } = await writeSettings(body, saved);
    if (answer) {
      take(answer);
      renderNav(lastIndex); // the `on` badge in the nav is part of the answer
    }
    return outcome;
  }

  async function load(): Promise<void> {
    const request = ++loadRequest;
    paneRequest++;
    const [got] = await Promise.all([
      getJson<ConfigIndex>(`/api/config${q()}`, "failed to load config", { cache: "no-store" }),
      loadCatalog(),
      registry.load(),
    ]);
    if (request !== loadRequest) return;
    if (!got.ok) {
      renderNav(null);
      renderError(got.error);
      return;
    }
    const index = got.value;
    if (scope === "global" && index.dir) {
      globalDir = index.dir;
      renderScopeOptions();
    }
    lastIndex = index;
    renderNav(index);
    if (!selection) renderPlaceholder();
    else if (selection.type === "sync") openSync();
  }

  // --- nav ---------------------------------------------------------------------

  /** `action`: the section's one primary action, at its right edge. */
  function navSection(title: string, action?: HTMLElement): HTMLElement {
    return h(
      "div",
      "flex items-center justify-between gap-2 px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400",
      h("span", "", title),
      ...(action ? [action] : []),
    );
  }

  const navBadge = (text: string): HTMLElement =>
    h("span", "flex-none rounded bg-neutral-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500", text);

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
    /** `navBadge()`s and `onBadge()`, trailing the label. */
    ...tags: HTMLElement[]
  ): HTMLElement {
    const row = h(
      "button",
      `config-row flex w-full cursor-pointer items-center gap-1.5 py-1.5 pr-3 text-left transition-colors hover:bg-neutral-100 ${
        active ? "bg-indigo-50 font-medium hover:bg-indigo-50" : ""
      } ${dim ? "text-neutral-400" : ""}`,
    );
    row.append(h("span", "truncate", label), ...tags);
    row.style.paddingLeft = `${20 + depth * 14}px`;
    row.title = label;
    row.onclick = onPick;
    return row;
  }

  function renderNav(index: ConfigIndex | null): void {
    if (!index) {
      navList.replaceChildren();
      return;
    }
    const isActive = (sel: Selection): boolean => JSON.stringify(sel) === JSON.stringify(selection);
    const open = (sel: Selection): void => {
      closeSync();
      selection = sel;
      renderNav(index); // re-highlight
      if (sel.type === "file") void openFile(sel.name, sel.readonly);
      else if (sel.type === "tools") openTools();
      else if (sel.type === "sync") openSync();
      else if (sel.type === "package") registry.openPackage(sel.source, sel.scope);
      else if (sel.type === "resource") void registry.openResource(sel.source, sel.kind, sel.path);
      else registry.openAdd();
    };
    const rows: HTMLElement[] = [];
    if (scope === "global") {
      const sel: Selection = { type: "sync" };
      rows.push(navSection("Instance"), navRow("Configuration sync", isActive(sel), false, () => open(sel)));
    }
    rows.push(navSection("Files"));
    for (const f of index.files) {
      const sel: Selection = { type: "file", name: f.name, readonly: f.readonly };
      rows.push(navRow(f.name, isActive(sel), !f.exists, () => open(sel)));
    }
    // Install, remove and update write the global settings.json only.
    const addSel: Selection = { type: "add" };
    const add = btn("Add package", `normal-case tracking-normal hover:underline ${isActive(addSel) ? "text-indigo-700" : "text-indigo-600"}`);
    add.onclick = () => open(addSel);
    rows.push(navSection("Packages", scope === "global" ? add : undefined));
    const packages = registry.registry?.packages ?? [];
    const busy = registry.registry?.busy ?? null;
    if (registry.error) rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-red-600", registry.error));
    for (const pkg of packages) {
      const sel: Selection = { type: "package", source: pkg.source, scope: pkg.scope };
      const tags: HTMLElement[] = [];
      if (busy === pkg.source || (busy === "every package" && pkg.kind !== "pier" && pkg.kind !== "local")) {
        tags.push(h("span", "flex-none text-[11px] text-neutral-400", pkg.installedPath ? "updating…" : "installing…"));
      } else if (pkg.resources.some((r) => r.enabled)) tags.push(onBadge());
      if (pkg.scope === "project") tags.push(navBadge("project"));
      // Dim: configured, and not on disk. The built-ins have no install path to speak of.
      const missing = pkg.installedPath === null && pkg.kind !== "pier" && pkg.kind !== "local";
      rows.push(navRow(packageLabel(pkg.source), isActive(sel), missing, () => open(sel), 0, ...tags));
    }
    // Flat, across packages: a resource has one switch wherever it is shown.
    for (const [title, kind] of [["Extensions", "extension"], ["Skills", "skill"]] as const) {
      rows.push(navSection(title));
      const found = packages.flatMap((pkg) => pkg.resources.filter((r) => r.kind === kind).map((r) => ({ pkg, r })));
      if (!found.length && !registry.error) rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-neutral-400", "none"));
      for (const { pkg, r } of found) {
        const sel: Selection = { type: "resource", source: pkg.source, kind, path: r.path };
        const tags = [navBadge(packageLabel(pkg.source)), ...(r.version ? [navBadge(r.version)] : [])];
        rows.push(navRow(r.name, isActive(sel), !r.enabled, () => open(sel), 0, ...tags));
      }
    }
    if (scope === "global") {
      // One row, not one per binary: the tools differ by name and version and
      // nothing else, so a page each would say the same three facts four times.
      rows.push(navSection("Tools"));
      if (catalogError) rows.push(h("p", "py-1 pl-5 pr-3 text-[12.5px] text-red-600", catalogError));
      else {
        const sel: Selection = { type: "tools" };
        const on = toolEntries().filter((t) => t.enabled).length;
        rows.push(navRow("command-line tools", isActive(sel), false, () => open(sel), 0, ...(on ? [onBadge()] : [])));
      }
    }
    navList.replaceChildren(...rows);
  }

  // --- pane --------------------------------------------------------------------

  function renderPlaceholder(): void {
    pane.replaceChildren(
      h(
        "div",
        "flex min-h-0 flex-1 items-center justify-center p-6",
        empty("Select a file to edit, or a package, extension or skill to switch."),
      ),
    );
  }

  function renderError(message: string): void {
    pane.replaceChildren(h("p", "px-4 py-3 text-[12.5px] leading-relaxed text-red-600", message));
  }

  /** A `readonly` file is Pier's to write: the viewer, no editor, and one
   *  line on where its content comes from. */
  async function openFile(name: string, readonly: boolean): Promise<void> {
    const request = ++paneRequest;
    const got = await getJson<{ content: string }>(
      `/api/config/files/${encodeURIComponent(name)}${q()}`,
      `failed to load ${name}`,
      { cache: "no-store" },
    );
    if (!got.ok) {
      if (request === paneRequest) renderError(got.error);
      return;
    }
    if (request !== paneRequest) return;
    const { content } = got.value;
    let expected = content;

    const status = h("span", "text-[11.5px] text-neutral-400", "");
    const save = h("button", "btn btn-primary text-[12.5px]", "Save") as HTMLButtonElement;
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
    // Opens in the shared viewer (code.ts); Edit swaps in the textarea. The
    // viewer renders the editor's own text, so switching back never hides an
    // unsaved line.
    const edit = h("button", "btn text-[12.5px]", "Edit") as HTMLButtonElement;
    const view = h("button", "btn text-[12.5px]", "View") as HTMLButtonElement;
    const actions = (...rest: HTMLElement[]): HTMLElement =>
      h("div", "ml-auto flex flex-none items-center gap-2", ...rest);
    const showEdit = (): void => {
      pane.replaceChildren(paneBar(name, status, actions(view, save)), editor);
      editor.focus();
    };
    const showRead = async (): Promise<void> => {
      const lang = await langFor(name); // first file of the session waits for hljs
      if (request !== paneRequest) return;
      pane.replaceChildren(
        readonly
          ? paneBar(name, h("span", "ml-auto text-[11px] uppercase tracking-wide text-neutral-400", "read-only"))
          : paneBar(name, status, actions(edit)),
        ...(readonly
          ? [h("p", "border-b border-neutral-200 px-4 py-2 text-[12.5px] leading-relaxed text-neutral-500",
            "Pier manages this file: the default model is set in Settings → Models; other keys are edited on disk, then pier reload.")]
          : []),
        h("div", "min-h-0 flex-1 overflow-auto", codePane(fileRows(editor.value), lang)),
      );
    };
    edit.onclick = showEdit;
    view.onclick = () => void showRead();
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

    await showRead();
  }

  /** Where every install and every failure already is: the update task's
   *  runs. Null until this Pier has managed to create that task. */
  function taskLink(text: string): HTMLElement | null {
    if (!toolsTaskId) return null;
    const link = h("a", "text-indigo-600 hover:underline", text) as HTMLAnchorElement;
    link.href = `#/tasks/${encodeURIComponent(toolsTaskId)}`;
    return link;
  }

  /** A body ubix rejects is only debuggable against ubix's own documentation. */
  const ubixLink = (): HTMLElement => {
    const link = h("a", "text-indigo-600 hover:underline", "ubix") as HTMLAnchorElement;
    link.href = "https://github.com/timqi/ubix";
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  };

  /** What a binary is right now, in one line. */
  function binaryLine(entry: CatalogEntry): string {
    const { spec, error, installed, version, path } = entry.binary;
    if (error) return `${spec} — ${error}`;
    if (!installed) return `${spec} — not installed`;
    return `${spec} — ${version ?? "unknown version"} at ${path ?? "an unknown path"}`;
  }

  /** Every command-line tool in one pane: a row, a line and a switch each,
   *  plus the operator's own blocks. */
  function openTools(note?: SaveOutcome, draft = { name: "", toml: "" }): void {
    paneRequest++;
    const status = h("span", "text-[11.5px] text-neutral-400", "");
    if (note) setStatus(status, note.state, note.text);
    const tools = toolEntries();
    const runs = taskLink("the update task");

    const row = (tool: CatalogEntry): HTMLElement => {
      const line = h(
        "div",
        "flex min-w-0 flex-1 flex-col gap-0.5",
        h(
          "span",
          "flex items-center gap-2 text-[13px] text-neutral-700",
          h("span", "font-mono", tool.name),
          ...(isCustom(tool) ? [badge("yours", "bg-neutral-50 text-neutral-500 ring-neutral-200")] : []),
        ),
        h("span", "text-[11.5px] leading-snug text-neutral-400", tool.summary || binaryLine(tool)),
        ...(tool.summary
          ? [h(
            "span",
            `font-mono text-[11px] leading-snug ${tool.binary.error ? "text-red-600" : "text-neutral-400"}`,
            binaryLine(tool),
          )]
          : []),
      );
      const box = toggle("", "", tool.enabled, (checked) => void flip(tool.name, checked, (outcome) => openTools(outcome)));
      const remove = h("button", "btn text-[12px] text-neutral-500 hover:text-red-600", "Remove") as HTMLButtonElement;
      remove.onclick = () => {
        remove.disabled = true;
        const step = removalStep(tool, customTools);
        void save(step.body, step.saved).then((outcome) => openTools(outcome));
      };
      return h(
        "div",
        "flex max-w-2xl items-start gap-3 border-b border-neutral-100 py-2.5 last:border-0",
        line,
        ...(isCustom(tool) ? [remove] : []),
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
        { customTools: [...customTools, entry], tool: { name: entry.name, on: true } },
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
            hint: "A line that opens a section of its own is refused, because it could rewrite the rest of the file.",
          }),
          h("div", "flex items-center gap-3", header, add),
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

  /** One switch, flipped: a delta, never the list this page computed — two
   *  quick clicks would each send a list built a moment ago. */
  async function flip(name: string, checked: boolean, redraw: (outcome: SaveOutcome) => void): Promise<void> {
    redraw(await save(
      { tool: { name, on: checked } },
      checked ? "Saved — installing now; watch the run." : "Saved — uninstalling in the next run.",
    ));
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
  }, closeSync);
}
