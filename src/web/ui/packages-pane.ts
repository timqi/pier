// Settings → Agent's package registry: the one GET /api/packages answer, every
// write against it, and the panes that act on a package, a resource or a new
// source. config.ts draws the nav from `registry` and hands the pane over.

import type { Package, PackageRegistry, PackageResource, PackageResourceKind, PackageScope } from "../../core/types.js";
import { failure, getJson, postJson } from "./api.js";
import { codePane, fileRows } from "./code.js";
import { agoLabel, basename, h } from "./dom.js";
import { badge, btn, empty, field, setStatus, textInput, toggle } from "./form.js";
import { langFor } from "./highlight.js";

export type RegistrySelection =
  | { type: "package"; source: string; scope: PackageScope }
  | { type: "resource"; source: string; kind: PackageResourceKind; path: string }
  | { type: "add" };

export interface RegistryDeps {
  pane: HTMLElement;
  paneBar: (name: string, ...rest: HTMLElement[]) => HTMLElement;
  /** A pane's ticket: `claim()` when it opens, `live(t)` before every later redraw. */
  claim(): number;
  live(ticket: number): boolean;
  /** The project scope's cwd; undefined for Global. */
  cwd(): string | undefined;
  /** The nav redraws itself from `registry` after every write. */
  changed(): void;
  /** Highlights a row; null clears. Never opens a pane — the caller does. */
  select(sel: RegistrySelection | null): void;
}

interface Outcome {
  state: "saved" | "failed";
  text: string;
}

const STATUS = "text-[11.5px] text-neutral-400";
const KIND_BADGE = "bg-neutral-50 text-neutral-500 ring-neutral-200";
const PIN_BADGE = "bg-amber-50 text-amber-700 ring-amber-100";
/** Pi's own security note, in front of every install. */
const SECURITY_NOTE =
  "Pi packages run with full system access: an extension executes arbitrary code, and a skill can instruct "
  + "the model to run anything. Review the source before installing.";

/** A source as a badge: the syntax and version stripped, so `npm:@scope/name@1.2` reads `name`. */
export const packageLabel = (source: string): string =>
  source === "pier" || source === "local"
    ? source
    : (source.replace(/^(npm|git):/, "").replace(/\.git$/, "").replace(/@[^@/]*$/, "").split("/").filter(Boolean).pop() ?? source);

/** Mirrors agent/packages.ts `kindOf`, for the row drawn before the server answers. */
const kindOf = (source: string): Package["kind"] =>
  source.startsWith("npm:") ? "npm" : /^(git:|\w+:\/\/)/.test(source) ? "git" : "path";

const isBuiltIn = (pkg: Package): boolean => pkg.kind === "pier" || pkg.kind === "local";

export function createRegistry(deps: RegistryDeps) {
  let registry: PackageRegistry | null = null;
  let error = "";
  const q = (): string => {
    const cwd = deps.cwd();
    return cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  };
  /** Add, Update, Remove and Check write the global settings.json only. */
  const manageable = (pkg: Package): boolean => !isBuiltIn(pkg) && pkg.scope === "global" && deps.cwd() === undefined;

  async function load(): Promise<void> {
    const got = await getJson<PackageRegistry>(`/api/packages${q()}`, "packages could not be loaded", { cache: "no-store" });
    // Another scope's rows would be a lie; nothing plus the sentence is not.
    registry = got.ok ? got.value : null;
    error = got.ok ? "" : got.error;
  }

  const find = (source: string, scope: PackageScope): Package | undefined =>
    registry?.packages.find((p) => p.source === source && p.scope === scope);

  const findResource = (
    source: string,
    kind: PackageResourceKind,
    path: string,
  ): { pkg: Package; resource: PackageResource } | undefined => {
    for (const pkg of registry?.packages.filter((p) => p.source === source) ?? []) {
      const resource = pkg.resources.find((r) => r.kind === kind && r.path === path);
      if (resource) return { pkg, resource };
    }
    return undefined;
  };

  /** Write the switch, then redraw from the row the server confirmed. */
  async function flip(pkg: Package, resource: PackageResource, enabled: boolean): Promise<Outcome> {
    const cwd = deps.cwd();
    const got = await postJson<PackageResource>(
      "/api/packages/resource",
      { source: pkg.source, kind: resource.kind, path: resource.path, enabled, ...(cwd ? { cwd } : {}) },
      "could not save",
      "PUT",
    );
    if (!got.ok) return { state: "failed", text: got.error };
    pkg.resources = pkg.resources.map((r) => (r.kind === resource.kind && r.path === resource.path ? got.value : r));
    deps.changed();
    return { state: "saved", text: "Saved — sessions take it on their next message." };
  }

  const renderError = (message: string): void => {
    deps.pane.replaceChildren(h("p", "px-4 py-3 text-[12.5px] leading-relaxed text-red-600", message));
  };
  const body = (...children: (HTMLElement | string)[]): HTMLElement =>
    h("div", "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4", ...children);
  const fact = (term: string, value: string | HTMLElement, mono = true): HTMLElement[] => [
    h("dt", "text-[12px] text-neutral-500", term),
    h("dd", `text-[12px] leading-snug text-neutral-700 ${mono ? "font-mono break-all" : ""}`, value),
  ];
  /** A locked switch is drawn as it stands, and `state` says whose it is. */
  const switchFor = (pkg: Package, r: PackageResource, label: string, hint: string, after: (outcome: Outcome) => void): HTMLElement => {
    const box = toggle(label, hint, r.enabled, (checked) => void flip(pkg, r, checked).then(after));
    if (r.locked) for (const input of box.querySelectorAll("input")) input.disabled = true;
    return box;
  };

  /** One resource, one switch: the same row in the package pane and the nav. */
  function resourceRow(pkg: Package, r: PackageResource, after: (outcome: Outcome) => void): HTMLElement {
    const name = btn(r.name, "font-mono text-[13px] text-neutral-700 hover:text-indigo-600 hover:underline");
    name.onclick = () => {
      const sel: RegistrySelection = { type: "resource", source: pkg.source, kind: r.kind, path: r.path };
      deps.select(sel);
      void openResource(sel.source, sel.kind, sel.path);
    };
    const line = h(
      "div",
      "flex min-w-0 flex-1 flex-col gap-0.5",
      h("span", "flex flex-wrap items-center gap-2", name, badge(r.kind, KIND_BADGE)),
      ...(r.state ? [h("span", "text-[11.5px] leading-snug text-amber-700", r.state)] : []),
    );
    return h("div", "flex max-w-2xl items-start gap-3 border-b border-neutral-100 py-2.5 last:border-0", line, switchFor(pkg, r, "", "", after));
  }

  function openPackage(source: string, scope: PackageScope, note?: Outcome): void {
    const ticket = deps.claim();
    const pkg = find(source, scope);
    if (!pkg) return renderError(`unknown package: ${source}`);
    const status = h("span", STATUS, "");
    if (note) setStatus(status, note.state, note.text);
    const busy = registry?.busy === pkg.source || (registry?.busy === "every package" && !isBuiltIn(pkg));
    if (busy && !note) setStatus(status, "saving", `${pkg.installedPath ? "updating" : "installing"}…`);
    const redraw = (outcome: Outcome): void => {
      if (deps.live(ticket)) openPackage(source, scope, outcome);
    };

    const facts: HTMLElement[] = [
      ...fact("Source", pkg.source),
      ...fact("Kind", pkg.kind === "pier" ? "built in — ships with Pier" : pkg.kind === "local" ? "the agent directory's own files" : pkg.kind, false),
      ...(pkg.version ? fact("Version", pkg.version) : []),
      // `pier` has no directory; a configured source that has none yet is missing.
      ...(pkg.installedPath !== null || !isBuiltIn(pkg) ? fact("Installed at", pkg.installedPath ?? "not installed", pkg.installedPath !== null) : []),
    ];
    const actions: HTMLElement[] = [];
    // A path package moves when its directory does: nothing to check or update.
    if (manageable(pkg) && pkg.kind !== "path") {
      const checked = registry?.checkedAt ? `checked ${agoLabel(Date.parse(registry.checkedAt))}` : "not checked yet";
      const check = btn("Check for updates", "btn text-[12px]");
      check.disabled = busy;
      check.onclick = () => {
        check.disabled = true;
        setStatus(status, "saving", "checking…");
        void postJson<PackageRegistry>("/api/packages/check", {}, "update check failed").then((got) => {
          // A failed check keeps the last answer; the sentence says why it is stale.
          if (got.ok) registry = got.value;
          deps.changed();
          const now = find(source, scope);
          redraw(
            !got.ok
              ? { state: "failed", text: got.error }
              : { state: "saved", text: now?.updateAvailable ? "Checked — an update is available." : "Checked — up to date." },
          );
        });
      };
      facts.push(...fact("Updates", h("span", "flex flex-wrap items-center gap-2",
        h("span", pkg.updateAvailable ? "text-emerald-700" : "", pkg.updateAvailable ? `update available (${checked})` : checked), check), false));
      const update = btn("Update", "btn text-[12.5px]");
      update.disabled = busy;
      update.onclick = () => {
        update.disabled = true;
        if (registry) registry = { ...registry, busy: pkg.source };
        deps.changed();
        redraw({ state: "saved", text: "updating…" });
        void postJson<{ packages: Package[] }>("/api/packages/update", { source: pkg.source }, "update failed").then(async (got) => {
          await load(); // the server's rows, `busy` included
          deps.changed();
          const now = got.ok ? got.value.packages.find((p) => p.source === pkg.source) : undefined;
          redraw(got.ok
            ? { state: "saved", text: `Updated${now?.version ? ` to ${now.version}` : ""} — sessions take it on their next message.` }
            : { state: "failed", text: got.error });
        });
      };
      actions.push(update);
    }
    if (manageable(pkg)) {
      const remove = btn("Remove", "btn text-[12.5px] text-neutral-600 hover:text-red-600");
      remove.disabled = busy;
      remove.onclick = () => {
        // Pi deletes what it installed; a directory of yours it only forgets.
        const then = pkg.kind === "path" ? "settings.json forgets it; the directory stays." : "Its files are deleted and settings.json forgets it.";
        if (!window.confirm(`Remove ${pkg.source}? ${then}`)) return;
        remove.disabled = true;
        setStatus(status, "saving", "removing…");
        void postJson<{ ok: true }>("/api/packages/remove", { source: pkg.source }, "remove failed").then(async (got) => {
          if (!got.ok) return redraw({ state: "failed", text: got.error });
          await load();
          deps.select(null);
          if (deps.live(ticket)) {
            deps.pane.replaceChildren(h("div", "flex min-h-0 flex-1 items-center justify-center p-6", empty(`Removed ${pkg.source}.`)));
          }
        });
      };
      actions.push(remove);
    }

    deps.pane.replaceChildren(
      deps.paneBar(
        packageLabel(pkg.source),
        badge(pkg.kind, KIND_BADGE),
        ...(pkg.scope === "project" ? [badge("project", PIN_BADGE)] : []),
        ...(actions.length ? [h("div", "ml-auto flex flex-none items-center gap-2", ...actions)] : []),
      ),
      body(
        h("dl", "grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1.5", ...facts),
        pkg.resources.length
          ? h("div", "flex max-w-2xl flex-col", ...pkg.resources.map((r) => resourceRow(pkg, r, redraw)))
          : empty(pkg.installedPath ? "No extensions or skills." : "Not installed — nothing to load."),
        status,
      ),
    );
  }

  /** What flipping this switch writes, in one line under it. */
  const hintFor = (pkg: Package, r: PackageResource): string => {
    if (r.locked) return "Switch it under Tools: the tool's install writes this file and its uninstall removes it.";
    if (pkg.kind === "pier") {
      return r.kind === "skill"
        ? "Pier's own skill. Off, no session is offered it."
        : "Loaded from inside Pier — nothing installed, nothing to update. A session mid-turn keeps the tools it started with.";
    }
    const file = deps.cwd() ? "this project's .pi/settings.json" : "settings.json";
    return `Written to ${file} as +path / −path for ${packageLabel(pkg.source)}; sessions pick it up on their next open.`;
  };

  async function openResource(source: string, kind: PackageResourceKind, path: string, note?: Outcome): Promise<void> {
    const ticket = deps.claim();
    const found = findResource(source, kind, path);
    if (!found) return renderError(`unknown ${kind}: ${path}`);
    const { pkg, resource } = found;
    const status = h("span", STATUS, "");
    if (note) setStatus(status, note.state, note.text);
    const content = h("div", "min-h-0 flex-1 overflow-auto");
    deps.pane.replaceChildren(
      deps.paneBar(
        resource.name,
        badge(packageLabel(pkg.source), KIND_BADGE),
        badge(resource.kind, KIND_BADGE),
        h("span", "ml-auto font-mono text-[11px] text-neutral-400 break-all", resource.path),
      ),
      h(
        "div",
        "flex flex-none flex-col gap-2 border-b border-neutral-200 px-4 py-3",
        switchFor(pkg, resource, "Enabled", hintFor(pkg, resource), (outcome) => {
          if (deps.live(ticket)) void openResource(source, kind, path, outcome);
        }),
        ...(resource.state ? [h("p", "text-[12px] text-amber-700", resource.state)] : []),
        status,
      ),
      content,
    );
    if (path.startsWith("<inline:")) {
      content.append(h("p", "px-4 py-3 text-[12.5px] text-neutral-400", "Loaded from inside Pier — there is no file to show."));
      return;
    }
    const text = await readFile(path);
    if (!deps.live(ticket)) return;
    if (!text.ok) return content.append(h("p", "px-4 py-3 text-[12.5px] text-red-600", text.error));
    const lang = await langFor(path);
    if (!deps.live(ticket)) return;
    content.append(codePane(fileRows(text.value), lang));
  }

  /** A resource file lives wherever its package does; /api/fs/file reads any
   *  absolute root, /api/config/* only the whitelisted agent files. */
  async function readFile(path: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const url = `/api/fs/file?root=${encodeURIComponent(dir)}&path=${encodeURIComponent(basename(path))}`;
    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (err) {
      return { ok: false, error: `could not read ${path}: ${String(err)}` };
    }
    if (!res.ok) return { ok: false, error: await failure(res, `could not read ${path}`) };
    return { ok: true, value: await res.text() };
  }

  function openAdd(note?: Outcome, draft = ""): void {
    const ticket = deps.claim();
    const status = h("span", STATUS, "");
    if (note) setStatus(status, note.state, note.text);
    let typed = draft;
    const input = textInput(draft, "npm:@scope/name · git:github.com/owner/repo · /path/to/package", (v) => (typed = v), true);
    const install = btn("Install", "btn btn-primary text-[12.5px]");
    const start = (): void => {
      const source = typed.trim();
      if (!source) return setStatus(status, "failed", "A package source is required.");
      install.disabled = true;
      setStatus(status, "saving", `installing ${source}…`);
      // The row appears now (principle 7); the server's list replaces it.
      if (registry) {
        registry = {
          ...registry,
          busy: source,
          packages: [...registry.packages, {
            source, kind: kindOf(source), scope: "global", version: null, installedPath: null, updateAvailable: false, resources: [],
          }],
        };
        deps.changed();
      }
      void postJson<{ package: Package }>("/api/packages", { source }, "install failed").then(async (got) => {
        await load();
        deps.changed();
        if (!deps.live(ticket)) return;
        if (!got.ok) return openAdd({ state: "failed", text: got.error }, source);
        const { package: pkg } = got.value;
        deps.select({ type: "package", source: pkg.source, scope: pkg.scope });
        openPackage(pkg.source, pkg.scope, {
          state: "saved",
          text: `Installed ${pkg.source} — sessions take it on their next message.`,
        });
      });
    };
    install.onclick = start;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") start();
    };
    deps.pane.replaceChildren(
      deps.paneBar("Add package"),
      body(
        h(
          "div",
          "flex max-w-2xl flex-col gap-3",
          field("Source", input, { hint: "What `pi install` takes: an npm package, a git URL (both may pin @version), or a directory on this machine." }),
          h("p", "text-[12.5px] leading-relaxed text-amber-800", SECURITY_NOTE),
          h("div", "flex items-center gap-3", install, status),
        ),
      ),
    );
    input.focus();
  }

  return {
    get registry() { return registry; },
    get error() { return error; },
    load,
    openPackage,
    openResource,
    openAdd,
  };
}
