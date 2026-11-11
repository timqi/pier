// The swatch group is a radio group: one tab stop, arrows move the pick, and
// the pick reads without its colour.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, installDom, type FakeDocument, type FakeElement } from "./dom.testkit.js";

let form: typeof import("./form.js");
let doc: FakeDocument;
beforeEach(async () => {
  vi.resetModules();
  doc = installDom();
  form = await import("./form.js");
});

afterEach(() => vi.unstubAllGlobals());

const OPTIONS: [string, string][] = [["indigo", "#0066df"], ["teal", "#037f75"], ["rose", "#c51b53"]];
const radios = (group: FakeElement): FakeElement[] => group.children;
const checked = (group: FakeElement): string[] =>
  radios(group).filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("aria-label")!);

it("draws one radio per preset, the pick ringed and checked, the rest out of the tab order", () => {
  const onChange = vi.fn();
  const group = fake(form.swatches(OPTIONS, "teal", onChange));
  expect(group.getAttribute("role")).toBe("radiogroup");
  expect(radios(group).map((r) => r.getAttribute("role"))).toEqual(["radio", "radio", "radio"]);
  expect(radios(group).map((r) => r.style.background)).toEqual(["#0066df", "#037f75", "#c51b53"]);
  expect(checked(group)).toEqual(["teal"]);
  expect(radios(group).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  const teal = radios(group)[1]!;
  expect(teal.className).toContain("ring-2");
  expect(teal.children.map((c) => c.localName)).toEqual(["svg"]);
  expect(radios(group)[0]!.children).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

it("moves the pick with the arrows, wrapping, and reports it once per move", () => {
  const onChange = vi.fn();
  const group = fake(form.swatches(OPTIONS, "rose", onChange));
  doc.body.append(group);
  const preventDefault = vi.fn();
  radios(group)[2]!.onkeydown!({ key: "ArrowRight", preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenLastCalledWith("indigo");
  expect(checked(group)).toEqual(["indigo"]);
  expect(doc.activeElement).toBe(radios(group)[0]);
  expect(radios(group).map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  radios(group)[0]!.onkeydown!({ key: "ArrowUp", preventDefault });
  expect(onChange).toHaveBeenLastCalledWith("rose");
  expect(checked(group)).toEqual(["rose"]);
  // Any other key is the browser's.
  radios(group)[2]!.onkeydown!({ key: "Tab", preventDefault });
  expect(onChange).toHaveBeenCalledTimes(2);
  radios(group)[1]!.onclick!();
  expect(onChange).toHaveBeenLastCalledWith("teal");
  expect(checked(group)).toEqual(["teal"]);
});

it("marks the open tab as the current page, by more than its colour", () => {
  const onClick = vi.fn();
  const open = fake(form.pill("Models", true, onClick));
  const other = fake(form.pill("Vault", false, onClick));
  expect(open.getAttribute("aria-current")).toBe("page");
  expect(other.hasAttribute("aria-current")).toBe(false);
  other.onclick!();
  expect(onClick).toHaveBeenCalledOnce();
});

// Coarse pointer: the badge's 2.75rem reach hangs over the control below it (style.css `.touch-reach`).
it("positions a field's control under a help badge, so its face answers before the badge's reach", () => {
  const control = (): HTMLElement => document.createElement("input");
  const plain = fake(form.field("Endpoint", control()));
  expect(plain.children[1]!.className).not.toContain("relative");
  const helped = fake(form.field("Bot token", control(), { help: document.createElement("button") }));
  expect(helped.children[0]!.children.map((c) => c.localName)).toEqual(["span", "button"]);
  expect(helped.children[1]!.className.split(" ")).toContain("pointer-coarse:relative");
});
