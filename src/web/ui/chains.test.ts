// The chain list: its rows, inline create and rename, archive's confirm, the archived fold and the chords.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChainInfo, ChainList } from "../types.js";
import { fake, FakeElement, installPage } from "./dom.testkit.js";

const menu = vi.hoisted(() => ({
  panel: null as HTMLElement | null,
  /** The row menu's items, by label, as the last ⋯ opened it. */
  items: new Map<string, () => void>(),
  closeMenu: vi.fn(() => { menu.panel?.remove(); menu.panel = null; }),
  openMenu: vi.fn((anchor: HTMLElement, items: { label: string; onSelect: () => void }[]) => {
    anchor.setAttribute("aria-expanded", "true");
    menu.items = new Map(items.map((i) => [i.label, i.onSelect]));
  }),
  openPanel: vi.fn((_anchor: HTMLElement, content: HTMLElement) => {
    const panel = document.createElement("div");
    panel.append(content);
    document.body.append(panel);
    menu.panel = panel;
    return panel;
  }),
}));
vi.mock("./menu.js", async (actual) => ({ ...(await actual<typeof import("./menu.js")>()), ...menu }));
const api = vi.hoisted(() => ({ sendJson: vi.fn<(url: string, body: unknown, method?: string) => Promise<Response>>() }));
vi.mock("./api.js", async (actual) => ({ ...(await actual<typeof import("./api.js")>()), sendJson: api.sendJson }));
const chords = vi.hoisted(() => new Map<string, () => void>());
vi.mock("./shortcut.js", () => ({ chord: (key: string, run: () => void) => chords.set(key, run), modalOpen: () => false }));

const chain = (id: string, over: Partial<ChainInfo> = {}): ChainInfo =>
  ({ id, name: id, createdAt: 1, unread: false, waiting: 0, ...over });
let list: ChainList | null;
let current: string | null;
const go = vi.fn();
const refresh = vi.fn();
const retitle = vi.fn();
let chains: typeof import("./chains.js");
const confirm = vi.fn(() => true);
/** The sidebar's `pier.rail` and whether the viewport docks it (≥ 64rem). */
const stored = new Map<string, string>();
let docked = true;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); chords.clear();
  installPage();
  // Laid out: the list redraws only a surface on screen.
  vi.spyOn(FakeElement.prototype, "getClientRects").mockReturnValue([{}]);
  vi.stubGlobal("window", { confirm, matchMedia: () => ({ matches: docked, addEventListener: vi.fn() }) });
  stored.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
  list = { chains: [chain("main", { waiting: 2 }), chain("ops", { createdAt: 2, head: { sessionId: "h", state: "streaming" } }),
    chain("old", { archivedAt: 3 })] };
  current = "main";
  chains = await import("./chains.js");
  chains.initChains({ list: () => list, current: () => current, go, refresh, anchor: () => document.querySelector("#chat-title")!, docked: retitle });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const floated = (): FakeElement => fake(menu.panel);
const names = (root: FakeElement) => root.querySelector("[data-list]")!.querySelectorAll(".chain-name").map((n) => n.textContent);
const inRow = (id: string, sel: string) => floated().querySelector(`[data-chain="${id}"]`)!.querySelector(sel)!;
const button = (root: FakeElement, text: string) => root.querySelectorAll("button").find((b) => b.textContent === text)!;
const settled = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const key = (input: FakeElement, k: string) => input.onkeydown?.({ key: k, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });

// One set of rows: dot, name, what waits, the current one marked; the rail is there once the list is read.
it("lists the active chains in the server's order with their marks, the rail once the list is read", () => {
  chains.renderChains();
  const rail = fake(document.querySelector("#chain-rail"));
  expect(rail.hasAttribute("data-on")).toBe(true);
  chains.openChains();
  expect(names(floated())).toEqual(["main", "ops"]);
  expect(inRow("main", ".chain-open").getAttribute("aria-current")).toBe("page");
  expect(inRow("main", ".chain-open").textContent).toContain("2 waiting");
  expect(inRow("ops", ".chain-dot").classList.contains("bg-sky-500")).toBe(true);
  expect(inRow("main", ".chain-dot").classList.contains("bg-amber-500")).toBe(true);
  expect(button(floated(), "Archived · 1").getAttribute("aria-expanded")).toBe("false");
  inRow("ops", ".chain-open").onclick?.();
  expect(go).toHaveBeenCalledWith("ops");
  expect(menu.closeMenu).toHaveBeenCalled();
  // The current chain's row goes too: it is the way back from Settings or an item view.
  chains.openChains();
  inRow("main", ".chain-open").onclick?.();
  expect(go).toHaveBeenLastCalledWith("main");
  list = null;
  chains.renderChains();
  expect(rail.hasAttribute("data-on")).toBe(false);
});

// New chain…: ↵ posts with a pending row, a refusal stays in the field with its sentence, Esc cancels.
it("creates a chain inline, its refusal said under the field, and navigates to it", async () => {
  chains.openChains();
  button(floated(), "New chain…").onclick?.();
  let input = floated().querySelector("input")!;
  expect(input.getAttribute("aria-label")).toBe("New chain name");
  input.value = "design";
  api.sendJson.mockResolvedValueOnce(Response.json({ error: 'chain: "design" exists' }, { status: 409 }));
  key(input, "Enter");
  expect(names(floated())).toEqual(["design", "main", "ops"]);
  await settled();
  input = floated().querySelector("input")!;
  expect(input.value).toBe("design");
  expect(floated().textContent).toContain('chain: "design" exists');
  api.sendJson.mockResolvedValueOnce(Response.json(chain("design"), { status: 201 }));
  key(input, "Enter");
  await settled();
  expect(api.sendJson).toHaveBeenLastCalledWith("/api/chains", { name: "design" });
  expect(refresh).toHaveBeenCalled();
  expect(go).toHaveBeenCalledWith("design");
  // ⌘⇧O takes the docked rail's field when the rail is on screen; Esc puts the button back.
  const rail = fake(document.querySelector("#chain-rail"));
  chords.get("shift+o")!();
  expect(menu.panel).toBeNull();
  input = rail.querySelector("input")!;
  // The field holds the focus when Esc arrives, as in a browser.
  input.focus();
  key(input, "Escape");
  expect(rail.querySelector("input")).toBeNull();
  // The rail's New chain is its Chains head's +; New chain… is the floated list's last row.
  expect(button(rail, "New chain…")).toBeUndefined();
  rail.querySelector("[aria-label='New chain']")!.onclick?.();
  expect(rail.querySelector("input")).not.toBeNull();
});

// A row's ⋯: Rename in place; Archive asks with the open count, then forces, the pane leaving an archived current chain.
it("renames in place and archives after the open count's confirm", async () => {
  chains.openChains();
  const more = () => inRow("main", ".chain-more");
  more().onclick?.();
  expect(menu.openMenu).toHaveBeenLastCalledWith(more(), expect.anything(), "main");
  expect([...menu.items.keys()]).toEqual(["Rename…", "Archive"]);
  // The menu took the floated list's panel; Rename… opens it again with the field in the row.
  menu.items.get("Rename…")!();
  const input = floated().querySelector("input")!;
  expect(input.value).toBe("main");
  api.sendJson.mockResolvedValueOnce(Response.json(chain("main", { name: "Home" })));
  input.value = "Home";
  key(input, "Enter");
  await settled();
  expect(api.sendJson).toHaveBeenLastCalledWith("/api/chains/main", { name: "Home" }, "PATCH");
  expect(floated().querySelector("input")).toBeNull();

  more().onclick?.();
  api.sendJson
    .mockResolvedValueOnce(Response.json({ error: "chain: main has 3 open — /status first", open: 3 }, { status: 409 }))
    .mockResolvedValueOnce(Response.json(chain("main", { archivedAt: 9 })));
  menu.items.get("Archive")!();
  await settled();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("3 open items"));
  expect(api.sendJson).toHaveBeenLastCalledWith("/api/chains/main", { archived: true, force: true }, "PATCH");
  expect(go).toHaveBeenCalledWith("ops");

  // Declined: nothing forced. The last active chain's refusal is said in the list, opened again for it.
  confirm.mockReturnValueOnce(false);
  api.sendJson.mockResolvedValueOnce(Response.json({ error: "chain: ops has 1 open", open: 1 }, { status: 409 }));
  chains.openChains(); // archiving succeeded with the menu in the list's place; the bar's title says so
  inRow("ops", ".chain-more").onclick?.();
  menu.items.get("Archive")!();
  await settled();
  expect(api.sendJson).toHaveBeenCalledTimes(4);
  api.sendJson.mockResolvedValueOnce(Response.json({ error: "chain: ops is the last active chain" }, { status: 400 }));
  menu.items.get("Archive")!();
  await settled();
  expect(floated().textContent).toContain("chain: ops is the last active chain");
});

it("folds the archived chains under Archived · N, each with Unarchive", async () => {
  chains.openChains();
  button(floated(), "Archived · 1").onclick?.();
  const back = floated().querySelector("[aria-label='Unarchive old']")!;
  api.sendJson.mockResolvedValueOnce(Response.json(chain("old")));
  back.onclick?.();
  await settled();
  expect(api.sendJson).toHaveBeenLastCalledWith("/api/chains/old", { archived: false }, "PATCH");
  expect(refresh).toHaveBeenCalled();
  api.sendJson.mockResolvedValueOnce(Response.json({ error: "no chain old" }, { status: 404 }));
  expect(await chains.unarchive("old")).toBe("no chain old");
});

it("cycles the active chains with ⌘⇧[ and ⌘⇧], wrapping, and stays on a lone one", () => {
  chords.get("shift+]")!();
  expect(go).toHaveBeenLastCalledWith("ops");
  chords.get("shift+[")!();
  expect(go).toHaveBeenLastCalledWith("ops");
  current = "ops";
  chords.get("shift+]")!();
  expect(go).toHaveBeenLastCalledWith("main");
  list = { chains: list!.chains.filter((c) => c.id !== "ops") };
  chords.get("shift+]")!();
  expect(go).toHaveBeenCalledTimes(3);
});

// One key for the sidebar: the docked rail where it is laid out, kept in pier.rail; the floated list below 64rem.
it("⌘B hides and shows the docked rail, remembered, and opens the floated list where there is no rail", () => {
  const rail = fake(document.querySelector("#chain-rail"));
  const read = list;
  list = null;
  chains.renderChains();
  expect(retitle).not.toHaveBeenCalled();
  // The list read docks the rail: the title is told, whoever re-rendered first (main.ts commitSessions).
  list = read;
  chains.renderChains();
  expect(chains.sidebarDocked()).toBe(true);
  expect(retitle).toHaveBeenCalledTimes(1);
  chains.renderChains();
  expect(retitle).toHaveBeenCalledTimes(1);
  // Hidden with the focus in it: the focus goes to the bar's title, the list's way in again.
  rail.querySelector('[data-chain="ops"]')!.querySelector(".chain-open")!.focus();
  chords.get("b")!();
  expect(rail.hasAttribute("data-on")).toBe(false);
  expect(stored.get("pier.rail")).toBe("off");
  expect(menu.openPanel).not.toHaveBeenCalled();
  // The bar's title turns back into the list's way in (session-header.ts).
  expect(retitle).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(document.querySelector("#chat-title"));
  expect(chains.sidebarDocked()).toBe(false);
  // Shown from the title, which becomes a heading: the focus goes to the rail's current row.
  chords.get("b")!();
  expect(rail.hasAttribute("data-on")).toBe(true);
  expect(stored.has("pier.rail")).toBe(false);
  expect(retitle).toHaveBeenCalledTimes(3);
  expect(document.activeElement).toBe(rail.querySelector('[data-chain="main"]')!.querySelector(".chain-open"));
  docked = false;
  expect(chains.sidebarDocked()).toBe(false);
  chords.get("b")!();
  expect(menu.openPanel).toHaveBeenCalledTimes(1);
  expect(rail.hasAttribute("data-on")).toBe(true);
  docked = true;
});

// The rail's arrows walk the section the focus is in — Chains, or the Items the drawer fills — never across them.
it("walks the arrows within the focused rail section, Chains or Items", () => {
  chains.renderChains();
  const rail = fake(document.querySelector("#chain-rail"));
  const items = fake(document.querySelector("#rail-items"));
  const list = fake(document.createElement("ul"));
  list.dataset.list = "";
  const row = (name: string) => { const li = document.createElement("li"); const b = document.createElement("button"); b.textContent = name; li.append(b); return fake(li); };
  list.append(row("auth"), row("deploy"));
  items.append(list);
  const down = () => { const ev = Object.assign(new Event("keydown", { cancelable: true }), { key: "ArrowDown", altKey: false, metaKey: false, shiftKey: false, ctrlKey: false }); rail.dispatchEvent(ev); return ev.defaultPrevented; };
  // A chain row is its pick and its ⋯, two stops; the walk wraps within the Chains section.
  rail.querySelector('[data-chain="ops"]')!.querySelector(".chain-more")!.focus();
  expect(down()).toBe(true);
  expect(fake(document.activeElement).closest("[data-chain]")!.dataset.chain).toBe("main");
  expect(fake(document.activeElement).classList.contains("chain-open")).toBe(true);
  items.querySelectorAll("button")[0]!.focus();
  expect(down()).toBe(true);
  expect(fake(document.activeElement).textContent).toBe("deploy");
  expect(down()).toBe(true);
  expect(fake(document.activeElement).textContent).toBe("auth");
});
