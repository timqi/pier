// The two moves a list answers to, in one place: the anchored menus and the
// composer's command list must not drift on which keys walk them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, installPage, labelled, type FakeDocument, type FakeElement } from "./dom.testkit.js";
import { listStep } from "./menu.js";

const key = (init: Partial<KeyboardEvent>): KeyboardEvent => init as KeyboardEvent;

it("walks on the arrows and on bare ⌃N/⌃J/⌃P/⌃K", () => {
  expect(listStep(key({ key: "ArrowDown" }))).toBe(1);
  expect(listStep(key({ key: "ArrowUp" }))).toBe(-1);
  expect(listStep(key({ key: "n", ctrlKey: true }))).toBe(1);
  expect(listStep(key({ key: "J", ctrlKey: true }))).toBe(1);
  expect(listStep(key({ key: "p", ctrlKey: true }))).toBe(-1);
  expect(listStep(key({ key: "k", ctrlKey: true }))).toBe(-1);
});

it("leaves alone a letter nobody held Ctrl for, and every chord the browser owns", () => {
  expect(listStep(key({ key: "n" }))).toBeUndefined();
  expect(listStep(key({ key: "n", ctrlKey: true, shiftKey: true }))).toBeUndefined(); // incognito window
  expect(listStep(key({ key: "n", metaKey: true }))).toBeUndefined(); // ⌘N is a new window
  expect(listStep(key({ key: "k", ctrlKey: true, altKey: true }))).toBeUndefined();
  expect(listStep(key({ key: "Enter" }))).toBeUndefined();
  expect(listStep(key({}))).toBeUndefined(); // synthetic event with no key
});

// Which events close an open panel: the user acting outside it, or its anchor
// moving — never the page scrolling or refreshing something else under it.
describe("closing", () => {
  let doc: FakeDocument;
  let win: EventTarget & { innerWidth: number; innerHeight: number };
  let menu: typeof import("./menu.js");
  let anchor: FakeElement;
  let pane: FakeElement;

  beforeEach(async () => {
    vi.resetModules();
    doc = installPage();
    win = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 });
    vi.stubGlobal("window", win);
    menu = await import("./menu.js");
    anchor = doc.querySelector("#chat-menu")!;
    pane = doc.querySelector("#turns")!;
  });
  afterEach(() => vi.unstubAllGlobals());

  /** As the browser delivers it: `target` is where it happened, not where it is heard. */
  const fire = (on: EventTarget, type: string, target: unknown): void => {
    const ev = new Event(type);
    Object.defineProperty(ev, "target", { value: target });
    on.dispatchEvent(ev);
  };
  const isOpen = (): boolean => anchor.getAttribute("aria-expanded") === "true";
  const open = (): FakeElement => {
    const content = doc.createElement("div");
    content.append(doc.createElement("button"));
    return fake(menu.openPanel(anchor as never, content as never));
  };

  it("stays open while a pane that does not hold the anchor scrolls, as the transcript does when a reply lands", () => {
    open();
    fire(win, "scroll", pane);
    expect(isOpen()).toBe(true);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("stays open when its own content scrolls", () => {
    const panel = open();
    fire(win, "scroll", panel);
    fire(doc, "wheel", panel.firstElementChild);
    expect(isOpen()).toBe(true);
  });

  it("closes when a scroll carries the anchor away", () => {
    open();
    fire(win, "scroll", doc);
    expect(isOpen()).toBe(false);
    open();
    fire(win, "scroll", anchor.parentElement);
    expect(isOpen()).toBe(false);
  });

  it("closes when the user wheels, points or focuses outside it, and on Esc", () => {
    for (const act of [
      () => fire(doc, "wheel", pane),
      () => fire(doc, "pointerdown", pane),
      () => fire(doc, "focusin", doc.querySelector("#input")),
      () => doc.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })),
    ]) {
      open();
      act();
      expect(isOpen()).toBe(false);
      expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    }
  });

  it("leaves a trigger that declares its popup to toggle it on click", () => {
    anchor.setAttribute("aria-haspopup", "true");
    open();
    fire(doc, "pointerdown", anchor);
    fire(doc, "focusin", anchor);
    expect(isOpen()).toBe(true);
    anchor.removeAttribute("aria-haspopup");
    fire(doc, "pointerdown", anchor);
    expect(isOpen()).toBe(false);
  });

  // 06 §Menus: every phone sheet is named and closable — the menus', the chain list's and the status panel's alike.
  it("heads a sheet with its title and a close control, a popover with neither, and focuses the content", () => {
    const content = (): [FakeElement, FakeElement] => {
      const box = doc.createElement("div");
      const off = doc.createElement("button");
      off.disabled = true; // Session info before the first reply
      const first = doc.createElement("button");
      box.append(off, first);
      return [box, first];
    };
    const [box, first] = content();
    const popover = fake(menu.openPanel(anchor as never, box as never, "Chains"));
    expect(labelled(popover, "Close Chains")).toBeUndefined();
    expect(popover.firstElementChild).toBe(box);
    expect(doc.activeElement).toBe(first);
    menu.closeMenu();
    win.innerWidth = 390;
    const [sheetBox, sheetFirst] = content();
    const sheet = fake(menu.openPanel(anchor as never, sheetBox as never, "Chains"));
    expect(sheet.dataset.presentation).toBe("sheet");
    expect(sheet.firstElementChild!.textContent).toBe("Chains");
    expect(doc.activeElement).toBe(sheetFirst);
    labelled(sheet, "Close Chains")!.onclick!();
    expect(isOpen()).toBe(false);
    menu.openMenu(anchor as never, [{ label: "Rename…", onSelect: vi.fn() }], "pier");
    const sheetMenu = fake(doc.querySelector('[data-menu="true"]'));
    expect(sheetMenu.firstElementChild!.textContent).toBe("pier");
    expect(labelled(sheetMenu, "Close menu")).toBeDefined();
  });

  it("leaves nothing listening once closed", () => {
    open();
    menu.closeMenu();
    const other = open();
    menu.closeMenu();
    fire(doc, "wheel", pane);
    expect(other.dataset.closing).toBe("");
    expect(isOpen()).toBe(false);
  });
});
