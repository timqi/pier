// Console → Files view: read-only browsing of a project directory. One tree,
// one viewer: the tree badges every file the working tree (or a chosen ref)
// drifted from the base ref — main by default — and a changed file opens as
// the whole file, syntax-highlighted, with added/removed lines toned inline,
// never a bare patch. Unchanged files preview as themselves (code with line
// numbers, images, PDFs). A viewer, not an editor: /api/explorer/* is scoped
// server-side to known project cwds, and nothing here writes.

import { getJson } from "./api.js";
import { codePane, plainRows, type CodeRow } from "./code.js";
import { openPathMenu } from "./dir-picker.js";
import { basename, consoleView, detailsRow, h, type ConsoleView } from "./dom.js";
import { langFor } from "./highlight.js";
import { commitHint, hoverHint, openDiffPicker, type Commit } from "./ref-picker.js";
import { letterKey } from "./shortcut.js";

interface Entry { name: string; dir: boolean }
interface GitInfo {
  branch: string | null;
  refs: { name: string; subject: string }[];
  commits: Commit[];
  /** Every checkout of this repository, this one included — the folder menu. */
  worktrees: { path: string; branch?: string }[];
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** name-status letters, toned like every diff tool tones them. */
const STATUS_TONE: Record<string, string> = {
  A: "text-emerald-600", M: "text-amber-600", D: "text-red-600",
};

/** Auto-expanding the tree to every change stops helping past a screenful. */
const MAX_AUTO_EXPAND = 30;

type Segment = { start: number; end: number; tone: "add" | "del" | "mixed" };

/** What a session was last looking at here. Browser-local, like every other
 *  view preference: it is where *this* workbench left off, and the answer is
 *  worth nothing to another one. */
type Prefs = { cwd: string; base: string; head: string };
const PREFS_KEY = "pier.filesPrefs";
const MAX_REMEMBERED = 50; // one entry per session; the oldest fall off

const allPrefs = (): Record<string, Prefs> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, Prefs>) : {};
  } catch {
    return {}; // hand-edited or from an older shape — start over
  }
};

const readPrefs = (sessionId: string): Prefs | null => {
  const p: Partial<Prefs> | undefined = sessionId ? allPrefs()[sessionId] : undefined;
  return typeof p?.cwd === "string" && typeof p.base === "string" && typeof p.head === "string"
    ? { cwd: p.cwd, base: p.base, head: p.head }
    : null;
};

const writePrefs = (sessionId: string, p: Prefs): void => {
  const all = allPrefs();
  delete all[sessionId]; // re-insert last, so the prune drops the least recent
  all[sessionId] = p;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete all[k];
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn("Files: could not remember this folder", err); // quota, or a private window
  }
};

/** The compare panel's control skin — a chip, like the header's model chip. */
const chip = (label: string, tone: "indigo" | "neutral" = "indigo"): HTMLButtonElement => {
  const el = h(
    "button",
    `min-w-0 cursor-pointer truncate rounded-md px-2 py-0.5 text-left font-mono text-[11.5px] ${
      tone === "indigo"
        ? "bg-indigo-50 font-medium text-indigo-700 hover:bg-indigo-100"
        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
    }`,
    label,
  ) as HTMLButtonElement;
  el.type = "button";
  return el;
};

export function createExplorerView(
  root: HTMLElement,
  /** The chat this was opened from: its id keys the remembered folder+diff,
   *  its cwd is where a bare open lands the first time. */
  session: () => { id: string; cwd: string } | undefined,
  /** Through the router (hash), so Back walks directories too. */
  openDir: (dir: string) => void,
  /** The ✕: leave the view, back to wherever it was opened from. */
  close: () => void,
): ConsoleView {
  let cwd = "";
  let sessionKey = ""; // whose folder+diff is on screen, and where it is saved
  let git: GitInfo = { branch: null, refs: [], commits: [], worktrees: [] };
  let base = "HEAD";
  let head = ""; // "" = working tree
  let changes = new Map<string, { status: string; add: number; del: number }>();
  let onlyChanged = true; // the diff is why you came; the full tree is one toggle away
  let collapsedAll = false;
  let savedExpanded: string[] = []; // what "collapse all" will restore
  const expanded = new Set<string>();
  let selectedPath: string | null = null;
  let selectedRow: HTMLElement | null = null;

  const header = h("header", "flex h-10 flex-none items-center gap-2 border-b border-neutral-200 bg-white px-3");
  const compare = h("div", "flex-none border-b border-neutral-200");
  const tree = h("div", "min-h-0 flex-1 overflow-y-auto py-1");
  const left = h("aside", "flex w-64 flex-none flex-col border-r border-neutral-200 text-[12.5px] max-md:h-2/5 max-md:w-full max-md:border-b max-md:border-r-0", compare, tree);
  // The viewer scrolls; `right` stays put so the minimap can pin to its edge.
  const viewer = h("div", "h-full min-w-0 overflow-auto");
  // pointer-events: only the marks catch clicks — the strip sits over the
  // viewer's scrollbar, which must stay draggable through it.
  const minimap = h("div", "pointer-events-none absolute inset-y-0 right-0 z-20 hidden w-2");
  const right = h("section", "relative min-w-0 flex-1", viewer, minimap);
  root.append(header, h("div", "flex min-h-0 flex-1 max-md:flex-col", left, right));

  const api = (ep: string, params: Record<string, string>): string =>
    `/api/explorer/${ep}?${new URLSearchParams({ root: cwd, ...params })}`;

  /** The shared read, thrown rather than returned: every caller here is inside
   *  a `try` already, because a listing that fails still has a tree to draw. */
  async function ask<T>(url: string, what: string): Promise<T> {
    const got = await getJson<T>(url, what);
    if (!got.ok) throw new Error(got.error);
    return got.value;
  }

  const note = (text: string, tone = "text-neutral-400"): HTMLElement =>
    h("p", `px-4 py-3 text-[12.5px] ${tone}`, text);

  // --- tree ---------------------------------------------------------------------------

  const changesUnder = (dir: string): number => {
    let n = 0;
    for (const p of changes.keys()) if (p.startsWith(`${dir}/`)) n++;
    return n;
  };

  /** fs listing + phantom rows for deleted paths, so every change stays
   *  reachable even when nothing is left on disk to click. The changed-only
   *  filter is applied here — one place decides what a directory shows. */
  function rowsFor(path: string, entries: Entry[]): HTMLElement[] {
    const names = new Set(entries.map((e) => e.name));
    const prefix = path ? `${path}/` : "";
    for (const [p, c] of changes) {
      if (c.status !== "D" || !p.startsWith(prefix)) continue;
      const seg = p.slice(prefix.length).split("/")[0]!;
      if (names.has(seg)) continue;
      names.add(seg);
      entries.push({ name: seg, dir: p.slice(prefix.length).includes("/") });
    }
    let list = entries;
    // No repo → nothing could pass the filter, so it must not apply (the
    // funnel toggle only renders for git projects).
    if (onlyChanged && git.branch) {
      list = entries.filter((e) =>
        e.dir ? changesUnder(`${prefix}${e.name}`) > 0 : changes.has(`${prefix}${e.name}`),
      );
    }
    list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return list.map((e) => (e.dir ? dirNode(`${prefix}${e.name}`, e.name) : fileRow(`${prefix}${e.name}`, e.name)));
  }

  async function entriesInto(box: HTMLElement, path: string): Promise<void> {
    try {
      const { entries } = await ask<{ entries: Entry[] }>(api("ls", { path }), "could not list this folder");
      box.replaceChildren(...rowsFor(path, entries));
      if (!box.childElementCount) box.append(note(onlyChanged ? "No changes." : "Empty."));
    } catch (err) {
      // A directory deleted in the working tree still has diffable children.
      const phantoms = rowsFor(path, []);
      if (phantoms.length) box.replaceChildren(...phantoms);
      else box.replaceChildren(note(String(err), "text-red-600"));
    }
  }

  function dirNode(path: string, name: string): HTMLElement {
    const n = changesUnder(path);
    const label = [h("span", "truncate", name)];
    if (n) label.push(h("span", "ml-auto flex-none rounded bg-amber-100/80 px-1 font-mono text-[10px] text-amber-700", String(n)));
    const { el, summary } = detailsRow("", label);
    summary.className += " px-2 py-0.5 hover:bg-neutral-100";
    const children = h("div", "pl-3");
    el.append(children);
    let loaded = false;
    const load = (): void => {
      if (loaded) return;
      loaded = true;
      children.append(note("…"));
      void entriesInto(children, path);
    };
    el.ontoggle = () => {
      expanded[el.open ? "add" : "delete"](path);
      if (el.open) load();
    };
    // The changed-only filter is a flat list of changes — everything unfolds.
    if ((onlyChanged && git.branch && !collapsedAll) || expanded.has(path)) {
      el.open = true;
      load();
    }
    return el;
  }

  function markSelected(row: HTMLElement): void {
    selectedRow?.classList.remove("bg-indigo-50", "text-indigo-700");
    selectedRow = row;
    row.classList.add("bg-indigo-50", "text-indigo-700");
  }

  function fileRow(path: string, name: string): HTMLElement {
    const status = changes.get(path)?.status;
    const row = h("button", "flex w-full cursor-pointer items-center gap-1.5 px-2 py-0.5 pl-6 text-left hover:bg-neutral-100", h("span", "truncate", name));
    if (status) row.append(h("span", `ml-auto flex-none font-mono text-[10.5px] font-semibold ${STATUS_TONE[status] ?? "text-neutral-500"}`, status));
    row.title = path;
    if (path === selectedPath) markSelected(row);
    row.onclick = () => {
      markSelected(row);
      selectedPath = path;
      void view(path);
    };
    return row;
  }

  const renderTree = (): void => void entriesInto(tree, "");

  // --- viewer -------------------------------------------------------------------------

  /** "+n −m" — the counts as color, no prose. */
  const countChips = (add: number, del: number): HTMLElement[] => [
    ...(add ? [h("span", "flex-none font-mono text-[10.5px] font-semibold text-emerald-600", `+${add}`)] : []),
    ...(del ? [h("span", "flex-none font-mono text-[10.5px] font-semibold text-red-600", `−${del}`)] : []),
  ];

  function viewerTitle(path: string, download: boolean, extra?: HTMLElement): HTMLElement {
    const change = changes.get(path);
    const title = h("div", "sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white px-4 py-1.5 font-mono text-[11.5px] text-neutral-500",
      h("span", "truncate", path));
    if (change) {
      title.append(h("span", `flex-none font-semibold ${STATUS_TONE[change.status] ?? ""}`, change.status));
      title.append(...countChips(change.add, change.del));
    }
    const tail = h("div", "ml-auto flex flex-none items-center gap-2");
    if (extra) tail.append(extra);
    if (download) {
      const dl = document.createElement("a");
      dl.className = "flex-none text-neutral-400 hover:text-indigo-700 hover:underline";
      dl.href = api("file", { path });
      dl.download = basename(path);
      dl.textContent = "Download";
      tail.append(dl);
    }
    title.append(tail);
    return title;
  }

  /** Character-level emphasis: pair the i-th removed line of a change site
   *  with its i-th added line, trim the common prefix and suffix, and mark
   *  what is left. No common edge means the line was rewritten — the row
   *  tone already says that, so no mark. */
  function markIntraline(rows: CodeRow[]): void {
    let i = 0;
    while (i < rows.length) {
      if (rows[i]!.tone !== "del") {
        i++;
        continue;
      }
      const dels = i;
      while (i < rows.length && rows[i]!.tone === "del") i++;
      const adds = i;
      while (i < rows.length && rows[i]!.tone === "add") i++;
      const pairs = Math.min(adds - dels, i - adds);
      for (let k = 0; k < pairs; k++) {
        const del = rows[dels + k]!;
        const add = rows[adds + k]!;
        const max = Math.min(del.text.length, add.text.length);
        let p = 0;
        while (p < max && del.text[p] === add.text[p]) p++;
        let s = 0;
        while (s < max - p && del.text[del.text.length - 1 - s] === add.text[add.text.length - 1 - s]) s++;
        if (p + s === 0) continue;
        del.mark = [p, del.text.length - s];
        add.mark = [p, add.text.length - s];
      }
    }
  }

  const diffNav = createDiffNav();

  /** The affordances that belong to a diff and to nothing else: the heatmap
   *  strip and the change stepper (whose keys go quiet with it). */
  function clearDiffChrome(): void {
    minimap.classList.add("hidden");
    minimap.replaceChildren();
    diffNav.set([], []);
  }

  /** Stale-response guard: only the newest view() may touch the viewer — a
   *  slow fetch for the last file must not overwrite the one now selected. */
  let viewSeq = 0;
  const current = (seq: number): boolean => seq === viewSeq;

  function view(path: string): Promise<void> {
    const seq = ++viewSeq;
    return changes.has(path) ? viewDiff(path, seq) : viewPlain(path, seq);
  }

  async function viewPlain(path: string, seq: number): Promise<void> {
    if (!current(seq)) return; // reached as a stale viewDiff's fallback
    clearDiffChrome();
    const url = api("file", { path });
    const body = h("div", "min-w-0");
    viewer.classList.remove("flex", "flex-col");
    viewer.replaceChildren(viewerTitle(path, true), body);
    if (IMG_EXT.test(path)) {
      const img = h("img", "max-w-full p-4") as HTMLImageElement;
      img.src = url;
      img.onerror = () => body.replaceChildren(note("Could not load image.", "text-red-600"));
      return void body.append(img);
    }
    if (path.toLowerCase().endsWith(".pdf")) {
      const frame = document.createElement("iframe");
      frame.className = "h-full w-full";
      frame.src = url;
      viewer.replaceChildren(viewerTitle(path, true), frame);
      viewer.classList.add("flex", "flex-col");
      return;
    }
    body.append(note("…"));
    const res = await fetch(url);
    if (!current(seq)) return;
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      return void body.replaceChildren(note(error ?? `HTTP ${res.status}`, "text-red-600"));
    }
    if (!(res.headers.get("content-type") ?? "").startsWith("text/plain")) {
      return void body.replaceChildren(note("Binary file — use Download."));
    }
    const lines = (await res.text()).split("\n");
    if (!current(seq)) return;
    if (lines.at(-1) === "") lines.pop(); // the trailing newline is not a line
    body.replaceChildren(codePane(plainRows(lines), langFor(path)));
  }

  /** `+`/`-`/context off the wire, two number columns on screen. The request
   *  asks for a huge context radius, so one hunk usually carries the whole file. */
  function parseDiff(diff: string): CodeRow[] {
    const rows: CodeRow[] = [];
    let oldN = 0;
    let newN = 0;
    let inHunk = false;
    const lines = diff.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        if (inHunk) rows.push({ nums: ["", ""], text: "⋯", tone: "" }); // a gap the context didn't cover
        [oldN, newN] = [Number(hunk[1]), Number(hunk[2])];
        inHunk = true;
        continue;
      }
      if (!inHunk || line.startsWith("\\")) continue; // headers, "\ No newline…"
      if (line.startsWith("+")) rows.push({ nums: ["", newN++], text: line.slice(1), tone: "add" });
      else if (line.startsWith("-")) rows.push({ nums: [oldN++, ""], text: line.slice(1), tone: "del" });
      else rows.push({ nums: [oldN++, newN++], text: line.slice(1), tone: "" });
    }
    return rows;
  }

  /** Contiguous toned runs — one entry per change site, for the nav and map. */
  function segmentsOf(rows: CodeRow[]): Segment[] {
    const segs: Segment[] = [];
    for (let i = 0; i < rows.length; i++) {
      const tone = rows[i]!.tone;
      if (!tone) continue;
      const last = segs.at(-1);
      if (last && last.end === i - 1) {
        last.end = i;
        if ((tone === "add" && last.tone === "del") || (tone === "del" && last.tone === "add")) last.tone = "mixed";
      } else {
        segs.push({ start: i, end: i, tone });
      }
    }
    return segs;
  }

  const SEG_TONE: Record<Segment["tone"], string> = {
    add: "bg-emerald-400", del: "bg-red-400", mixed: "bg-amber-400",
  };

  /** The heatmap strip: every change site as a proportional, clickable mark. */
  function renderMinimap(segs: Segment[], total: number, rowEls: HTMLElement[]): void {
    minimap.replaceChildren(...segs.map((s) => {
      const mark = h("button", `pointer-events-auto absolute w-full cursor-pointer ${SEG_TONE[s.tone]}`);
      mark.style.top = `${(s.start / total) * 100}%`;
      mark.style.height = `${Math.max(0.4, ((s.end - s.start + 1) / total) * 100)}%`;
      mark.title = `line ${rowsLabel(rowEls, s.start)}`;
      mark.onclick = () => rowEls[s.start]!.scrollIntoView({ block: "center" });
      return mark;
    }));
    minimap.classList.remove("hidden");
  }

  const rowsLabel = (rowEls: HTMLElement[], i: number): string =>
    rowEls[i]?.querySelector("span")?.textContent?.trim() || String(i + 1);

  /**
   * ↑/↓ stepping through change sites, wrapping at the ends — with P/N (or
   * K/J) on the keys, since walking a diff is the whole point of the view.
   *
   * Built once and refilled per file rather than rebuilt with the title: a
   * bare-letter binding is never unbound, so a nav per rendered diff would
   * stack one more listener for every file opened.
   */
  function createDiffNav(): { el: HTMLElement; set: (segs: Segment[], rowEls: HTMLElement[]) => void } {
    let segs: Segment[] = [];
    let rowEls: HTMLElement[] = [];
    let idx = -1;
    const counter = h("span", "flex-none text-[10.5px] text-neutral-400");
    const go = (d: number): void => {
      if (!segs.length) return;
      idx = (idx + d + segs.length) % segs.length;
      rowEls[segs[idx]!.start]!.scrollIntoView({ block: "center" });
      counter.textContent = `${idx + 1}/${segs.length}`;
    };
    // The keys are this view's only while it is on screen with a diff in it.
    const live = (): boolean => segs.length > 0 && !root.classList.contains("hidden");
    const arrow = (glyph: string, d: number, label: string, keys: [string, string]): HTMLElement => {
      const el = h("button", "icon-btn flex-none", glyph);
      el.onclick = () => go(d);
      letterKey(el, keys, label, () => go(d), live);
      return el;
    };
    return {
      el: h(
        "div",
        "flex flex-none items-center gap-1",
        counter,
        arrow("↑", -1, "Previous change", ["p", "k"]),
        arrow("↓", 1, "Next change", ["n", "j"]),
      ),
      set(next, rows) {
        segs = next;
        rowEls = rows;
        idx = -1;
        counter.textContent = `${next.length} change${next.length === 1 ? "" : "s"}`;
      },
    };
  }

  async function viewDiff(path: string, seq: number): Promise<void> {
    clearDiffChrome();
    viewer.classList.remove("flex", "flex-col");
    const canDownload = changes.get(path)?.status !== "D";
    viewer.replaceChildren(viewerTitle(path, canDownload), note("…"));
    try {
      const { diff } = await ask<{ diff: string }>(
        api("diff", { base, head, file: path, context: "99999" }),
        "could not read this diff",
      );
      if (!current(seq)) return;
      if (!diff || /^Binary files /m.test(diff)) return viewPlain(path, seq); // mode-only change, or an image
      const rows = parseDiff(diff);
      markIntraline(rows);
      const pane = codePane(rows, langFor(path));
      const rowEls = [...pane.children] as HTMLElement[];
      const segs = segmentsOf(rows);
      diffNav.set(segs, rowEls);
      viewer.replaceChildren(viewerTitle(path, canDownload, diffNav.el), pane);
      renderMinimap(segs, rows.length, rowEls);
    } catch (err) {
      if (current(seq)) viewer.replaceChildren(viewerTitle(path, false), note(String(err), "text-red-600"));
    }
  }

  // --- compare (what ↔ what produced this diff) -----------------------------------------

  /** head/base as one commit's own diff, when that is what they encode. */
  const pickedCommit = (): string => (head && base === `${head}~1` ? head : "");

  const pickedSubject = (): string => git.commits.find((c) => c.hash === pickedCommit())?.subject ?? "";

  /** The diff's name — what the picker produced, worn as the control. A bare
   *  hash says nothing, so a picked commit wears its subject too. */
  const diffLabel = (): string =>
    pickedCommit()
      ? `${pickedCommit()} — ${pickedSubject() || "commit"}`
      : `${base} ↔ ${head || "working tree"}`;

  const ICON_FUNNEL = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><path d="M2.5 3h11l-4.25 5v4.5l-2.5 1.25V8L2.5 3z" stroke-linejoin="round"/></svg>`;
  const ICON_FOLD = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><path d="m4.5 2.5 3.5 3 3.5-3M4.5 13.5l3.5-3 3.5 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const iconToggle = (svg: string, hint: string, active: boolean, onClick: () => void): HTMLElement => {
    const el = h("button", `flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md ${
      active ? "bg-indigo-50 text-indigo-700" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
    }`);
    el.innerHTML = svg;
    el.title = hint;
    el.onclick = onClick;
    return el;
  };

  function renderCompare(): void {
    const funnel = iconToggle(ICON_FUNNEL, "Show only files that differ", onlyChanged, () => {
      onlyChanged = !onlyChanged;
      renderCompare();
      renderTree();
    });
    const fold = iconToggle(ICON_FOLD, collapsedAll ? "Restore folders" : "Collapse all folders", collapsedAll, () => {
      collapsedAll = !collapsedAll;
      if (collapsedAll) {
        savedExpanded = [...expanded];
        expanded.clear();
      } else {
        for (const p of savedExpanded) expanded.add(p); // manual opens survive the merge
      }
      renderCompare();
      renderTree();
    });
    // No repo → no diff to pick, but folding the tree still applies.
    if (!git.branch) {
      compare.replaceChildren(h("div", "flex items-center justify-end gap-1 p-1.5", fold));
      return;
    }
    const picker = chip(diffLabel());
    if (pickedCommit()) {
      const c = git.commits.find((x) => x.hash === pickedCommit());
      hoverHint(picker, () => (c ? commitHint(c) : ""));
    } else {
      picker.title = "Choose what to diff";
    }
    picker.onclick = async () => {
      await refreshGit(); // a commit made since the view opened must be pickable
      openDiffPicker(
        picker,
        git,
        { base, head },
        (b, hd) => {
          base = b;
          head = hd;
          void applyRefs();
        },
        defaultBase(),
      );
    };
    let [adds, dels] = [0, 0];
    for (const c of changes.values()) {
      adds += c.add;
      dels += c.del;
    }
    compare.replaceChildren(h("div", "flex flex-col gap-1 p-2",
      picker,
      h("div", "flex items-center gap-1.5 pl-1",
        h("span", "text-[11px] text-neutral-400", `${changes.size} changed file${changes.size === 1 ? "" : "s"}`),
        ...countChips(adds, dels),
        h("span", "ml-auto"),
        funnel,
        fold)));
  }

  /** Written on every change, not on close: the view is an overlay and its ✕
   *  is one of several ways out (a hash change, a closed tab). */
  const remember = (): void => {
    if (sessionKey && cwd) writePrefs(sessionKey, { cwd, base, head });
  };

  /** A remembered ref may be gone — a merged branch, a commit past the log
   *  window. Fall back to the default diff rather than open on a git error. */
  const usableRef = (ref: string): boolean => {
    const name = ref.replace(/~\d+$/, "");
    return !name || name === "HEAD" || git.refs.some((r) => r.name === name) ||
      git.commits.some((c) => c.hash === name);
  };

  async function loadChanges(): Promise<void> {
    changes = new Map();
    if (!git.branch) return;
    const { files } = await ask<{ files: { status: string; path: string; add: number; del: number }[] }>(
      api("diff", { base, head }),
      "could not read what changed",
    );
    for (const f of files) changes.set(f.path, { status: f.status, add: f.add, del: f.del });
    // Unfold the tree down to every change — the badge trail, pre-walked.
    if (changes.size <= MAX_AUTO_EXPAND) {
      for (const p of changes.keys()) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
      }
    }
  }

  async function applyRefs(): Promise<void> {
    remember();
    try {
      await loadChanges();
    } catch (err) {
      renderCompare();
      tree.replaceChildren(note(String(err), "text-red-600"));
      return;
    }
    renderCompare();
    renderTree();
    if (selectedPath) void view(selectedPath);
  }

  // --- header + orchestration ----------------------------------------------------------

  function renderHeader(): void {
    const cwdChip = chip(cwd || "Choose a folder…", "neutral");
    cwdChip.className += " max-w-72";
    cwdChip.title = "Switch folder";
    // Every checkout of the repository on screen, and nothing else. Parallel
    // work means hopping between worktrees of one project, which is worth a
    // click; a list of every directory the instance has ever had a session in
    // is a list of places this view is not about. Those are one "Browse…"
    // away, and that panel takes a typed path.
    cwdChip.onclick = () =>
      openPathMenu(
        cwdChip,
        git.worktrees.map((w) => ({ path: w.path, ...(w.branch ? { hint: w.branch } : {}) })),
        cwd || undefined,
        openDir, // hash first; show() reloads
      );
    const closeBtn = h("button", "icon-btn ml-auto", "✕") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.title = "Close Files";
    closeBtn.setAttribute("aria-label", "Close Files");
    closeBtn.onclick = close;
    header.replaceChildren(
      cwdChip,
      h("span", "truncate font-mono text-[11.5px] text-neutral-400", git.branch ? `⎇ ${git.branch}` : "no git"),
      closeBtn,
    );
  }

  /** Refs, commits and the branch move under the view — a commit made in a
   *  terminal is invisible here and nothing pushes it — so re-read them
   *  whenever the answer is about to be shown (re-entering the view) or used
   *  (opening the diff picker). Errors land where load()'s git failure does. */
  async function refreshGit(): Promise<void> {
    if (!cwd) return;
    try {
      git = await ask<GitInfo>(api("git", {}), "could not read this repository");
      renderHeader(); // the branch may have moved too
    } catch (err) {
      viewer.replaceChildren(note(String(err), "text-red-600"));
    }
  }

  /** The base worth drifting from: the repo's main line when it has one. */
  const defaultBase = (): string =>
    git.refs.some((r) => r.name === "main") ? "main" : git.refs.some((r) => r.name === "master") ? "master" : "HEAD";

  async function load(): Promise<void> {
    renderHeader();
    selectedPath = null;
    selectedRow = null;
    expanded.clear();
    clearDiffChrome();
    viewer.classList.remove("flex", "flex-col");
    viewer.replaceChildren(note("Select a file."));
    if (!cwd) {
      compare.replaceChildren();
      tree.replaceChildren();
      viewer.replaceChildren(note("No folder yet — pick one from the chip above."));
      return;
    }
    try {
      git = await ask<GitInfo>(api("git", {}), "could not read this repository");
    } catch (err) {
      git = { branch: null, refs: [], commits: [], worktrees: [] };
      viewer.replaceChildren(note(String(err), "text-red-600"));
    }
    // The diff this session last chose here, when it still resolves.
    const saved = readPrefs(sessionKey);
    const kept = saved && saved.cwd === cwd && usableRef(saved.base) && usableRef(saved.head) ? saved : null;
    base = kept?.base ?? defaultBase();
    head = kept?.head ?? "";
    renderHeader(); // now with the branch
    await applyRefs();
  }

  return consoleView(root, (arg) => {
    const s = session();
    const id = s?.id ?? "";
    // Any absolute path is addressable.
    // A stale or relative argument falls back to what this session last
    // browsed, then to its own project directory. No first-project fallback:
    // landing in somebody else's repository is worse than the empty chip that
    // asks which folder you meant.
    const next = arg?.startsWith("/")
      ? arg
      : (id === sessionKey ? cwd : "") || readPrefs(id)?.cwd || s?.cwd || "";
    if (next === cwd && id === sessionKey && tree.childElementCount) {
      // Back to the view: keep tree + selection, but re-read git and the diff —
      // both moved while it was away.
      renderHeader();
      void refreshGit().then(applyRefs);
      return;
    }
    sessionKey = id;
    cwd = next;
    void load();
  }, () => {
    // A whole file's diff is thousands of rows, each a handful of highlighted
    // spans, and hiding the view only flips a class — the largest DOM in the
    // workbench sat there for the life of the page. Re-entering re-reads git and
    // re-renders the selected file anyway (applyRefs), so nothing is lost; the
    // placeholder is what an empty viewer must never be (principle 5b).
    clearDiffChrome();
    viewer.classList.remove("flex", "flex-col");
    viewer.replaceChildren(note("Select a file."));
  });
}
