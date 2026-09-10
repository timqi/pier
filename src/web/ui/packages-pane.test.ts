// Settings → Agent drawn from one GET /api/packages answer, with a small DOM
// double: the nav, one switch written and redrawn from the server's row, an
// install that shows its row before the answer, and a refusal shown as failed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Package, PackageRegistry } from "../../core/types.js";

class Element {
  children: (Element | string)[] = [];
  classList = { add: vi.fn(), remove: vi.fn() };
  className = "";
  value = "";
  checked = false;
  disabled = false;
  title = "";
  type = "";
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onkeydown: ((ev: { key: string }) => void) | null = null;
  constructor(readonly tag: string) {}
  get options(): Element[] { return this.children.filter((c): c is Element => typeof c !== "string"); }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  focus = vi.fn();
  get textContent(): string { return this.children.map((c) => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(text: string) { this.children = [text]; }
}
const walk = (el: Element): Element[] => [el, ...el.children.flatMap((c) => typeof c === "string" ? [] : walk(c))];
const make = (tag: string, cls = "", ...children: (Element | string)[]): Element => {
  const el = new Element(tag);
  el.className = cls;
  el.append(...children);
  return el;
};

vi.mock("./dom.js", () => ({
  h: (...args: Parameters<typeof make>) => make(...args),
  basename: (p: string) => p.split("/").filter(Boolean).pop() ?? p,
  agoLabel: () => "just now",
  consoleView: (_root: Element, load: () => void) => ({ visible: false, show() { load(); }, hide() {} }),
}));
vi.mock("./form.js", () => ({
  CONTROL: "", PANEL: "", PANEL_HEAD: "",
  badge: (text: string) => make("span", "badge", text),
  btn: (label: string, cls = "") => make("button", cls, label),
  empty: (text: string) => make("p", "empty", text),
  field: (label: string, control: Element) => make("div", "", label, control),
  setStatus: (el: Element, state: string, text: string) => { el.className = state; el.textContent = text; },
  textInput: (value: string, _ph: string, onInput: (v: string) => void) => {
    const el = make("input"); el.value = value; el.oninput = () => onInput(el.value); return el;
  },
  toggle: (label: string, _hint: string, checked: boolean, onChange: (v: boolean) => void) => {
    const box = make("input"); box.type = "checkbox"; box.checked = checked; box.onchange = () => onChange(box.checked);
    return make("label", "", box, label);
  },
}));
vi.mock("./code.js", () => ({ fileRows: (text: string) => text, codePane: (text: string) => make("pre", "", text) }));
vi.mock("./highlight.js", () => ({ langFor: async () => null }));
vi.mock("./config-sync.js", () => ({ configSyncPane: () => ({ el: make("div"), dispose() {} }) }));

import { createConfigView } from "./config.js";

const resource = (kind: "extension" | "skill", name: string, path: string, enabled: boolean, extra: Partial<Package["resources"][number]> = {}) =>
  ({ kind, name, path, enabled, state: null, ...extra });
const pier: Package = {
  source: "pier", kind: "pier", scope: "global", version: "0.1.2", installedPath: null, updateAvailable: false,
  resources: [
    resource("extension", "web", "<inline:web>", false),
    resource("skill", "pier-help", "/pier/skills/pier-help/SKILL.md", true),
  ],
};
const local: Package = {
  source: "local", kind: "local", scope: "global", version: null, installedPath: "/pi", updateAvailable: false,
  resources: [resource("extension", "rtk", "/pi/extensions/rtk.ts", true, { state: "installed by the rtk tool", locked: true })],
};
const demo: Package = {
  source: "npm:@acme/demo@1.0.0", kind: "npm", scope: "global", version: "1.0.0", installedPath: "/pi/packages/npm/demo",
  updateAvailable: false, resources: [resource("extension", "hello", "/pi/packages/npm/demo/extensions/hello.ts", true)],
};
let registry: PackageRegistry;
let root: Element;
let fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
/** The next POST /api/packages answers this; a promise parks it. */
let install: () => Promise<Response>;
const settled = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const rows = () => walk(root).filter((el) => el.className.includes("config-row"));
const row = (label: string) => rows().find((el) => (el.children[0] as Element).textContent === label);
const rowText = (label: string) => row(label)!.textContent;
const button = (text: string) => walk(root).find((el) => el.tag === "button" && el.textContent === text);
const sent = (method: string) =>
  fetcher.mock.calls.filter(([, init]) => init?.method === method).map(([url, init]) => [url, JSON.parse(String(init?.body))]);
const status = () => walk(root).find((el) => el.className === "saved" || el.className === "failed" || el.className === "saving");

beforeEach(async () => {
  registry = { packages: [pier, local, demo], checkedAt: null, busy: null };
  root = new Element("div");
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("Option", class extends Element {
    constructor(label: string, value: string) { super("option"); this.append(label); this.value = value; }
  });
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  install = async () => Response.json({ package: { ...demo, source: "npm:new", version: "2.0.0" } });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/config?")) return Response.json({ dir: "/pi", files: [{ name: "SYSTEM.md", exists: true, readonly: false }] });
    if (url === "/api/settings") return Response.json({ catalog: [], customTools: [], toolsTaskId: null });
    if (url === "/api/packages" && init?.method === "POST") return install();
    if (url === "/api/packages") return Response.json(registry);
    if (url === "/api/packages/resource" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { source: string; path: string; enabled: boolean };
      const found = registry.packages.find((p) => p.source === body.source)!.resources.find((r) => r.path === body.path)!;
      const flipped = { ...found, enabled: body.enabled };
      found.enabled = body.enabled;
      return Response.json(flipped);
    }
    if (url.startsWith("/api/fs/file?")) return new Response("# help", { headers: { "content-type": "text/plain" } });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  createConfigView(root as unknown as HTMLElement, () => []).show();
  await settled();
});
afterEach(() => vi.unstubAllGlobals());

describe("Settings → Agent", () => {
  it("draws the nav from the registry: packages, then extensions and skills across them", () => {
    const sections = walk(root).filter((el) => el.className.includes("uppercase") && el.tag === "div").map((el) => el.textContent);
    expect(sections).toEqual(["Instance", "Files", "PackagesAdd package", "Extensions", "Skills", "Tools"]);
    expect(rows().map((el) => el.textContent)).toEqual([
      "Configuration sync", "SYSTEM.md",
      "pieron", "localon", "demoon",
      "webpier", "rtklocal", "hellodemo",
      "pier-helppier",
      "command-line tools",
    ]);
    // A switched-off resource reads dim; a package with none on carries no badge.
    expect(row("web")!.className).toContain("text-neutral-400");
    expect(row("rtk")!.className).not.toContain("text-neutral-400");
  });

  it("flips one switch: the PUT names the resource, and both views redraw from the answer", async () => {
    row("web")!.onclick!();
    await settled();
    // The resource pane: its file, or the line that there is none.
    expect(walk(root).some((el) => el.textContent === "Loaded from inside Pier — there is no file to show.")).toBe(true);
    const box = walk(root).find((el) => el.type === "checkbox")!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.onchange!();
    await settled();
    expect(sent("PUT")).toEqual([[
      "/api/packages/resource",
      { source: "pier", kind: "extension", path: "<inline:web>", enabled: true },
    ]]);
    expect(walk(root).find((el) => el.type === "checkbox")!.checked).toBe(true);
    expect(row("web")!.className).not.toContain("text-neutral-400");
    expect(status()?.textContent).toContain("Saved");
    // No second list was fetched: the answer is the state.
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/packages")).toHaveLength(1);
  });

  it("shows a skill's file through /api/fs/file, from wherever its package keeps it", async () => {
    row("pier-help")!.onclick!();
    await settled();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/fs/file?root=%2Fpier%2Fskills%2Fpier-help&path=SKILL.md",
      expect.anything(),
    );
    expect(walk(root).find((el) => el.tag === "pre")?.textContent).toBe("# help");
  });

  it("installs: the row appears before the answer, then the list is the server's", async () => {
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    install = async () => {
      await parked;
      registry = { ...registry, packages: [...registry.packages, { ...demo, source: "npm:new", version: "2.0.0" }] };
      return Response.json({ package: { ...demo, source: "npm:new", version: "2.0.0" } });
    };
    button("Add package")!.onclick!();
    await settled();
    const input = walk(root).find((el) => el.tag === "input")!;
    input.value = " npm:new ";
    input.oninput!();
    button("Install")!.onclick!();
    await settled();
    expect(rowText("new")).toBe("newinstalling…");
    expect(button("Install")!.disabled).toBe(true);
    release();
    await settled();
    expect(sent("POST")).toEqual([["/api/packages", { source: "npm:new" }]]);
    expect(rowText("new")).toBe("newon");
    expect(row("new")!.className).toContain("bg-indigo-50"); // selected
    expect(status()?.textContent).toBe("Installed npm:new — sessions take it on their next message.");
  });

  it("shows a refused install as failed, and drops the row it drew", async () => {
    install = async () => Response.json({ error: "npm:other is being changed; try again when it finishes" }, { status: 409 });
    button("Add package")!.onclick!();
    await settled();
    const input = walk(root).find((el) => el.tag === "input")!;
    input.value = "npm:new";
    input.oninput!();
    button("Install")!.onclick!();
    await settled();
    expect(row("new")).toBeUndefined();
    expect(status()?.className).toBe("failed");
    expect(status()?.textContent).toBe("npm:other is being changed; try again when it finishes");
    // What was typed is still there for the retry.
    expect(walk(root).find((el) => el.tag === "input")!.value).toBe("npm:new");
  });
});
