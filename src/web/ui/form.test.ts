// The swatch group is a radio group: one tab stop, arrows move the pick, and
// the pick reads without its colour.
import { beforeEach, expect, it, vi } from "vitest";

class Element {
  children: (Element | string)[] = [];
  className = "";
  type = "";
  title = "";
  tabIndex = 0;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onkeydown: ((ev: { key: string; preventDefault: () => void }) => void) | null = null;
  focus = vi.fn();
  classList = {
    toggle: (cls: string, on: boolean) => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      if (on) set.add(cls);
      else set.delete(cls);
      this.className = [...set].join(" ");
    },
  };
  constructor(readonly tag: string) {}
  append(...kids: (Element | string)[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: (Element | string)[]): void {
    this.children = kids;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
}

vi.mock("./dom.js", () => ({
  h: (tag: string, cls: string, ...kids: (Element | string)[]) => {
    const el = new Element(tag);
    el.className = cls;
    el.append(...kids);
    return el;
  },
  prose: vi.fn(),
}));
vi.mock("./icons.js", () => ({ icon: () => new Element("svg") }));

let form: typeof import("./form.js");
beforeEach(async () => {
  vi.resetModules();
  form = await import("./form.js");
});

const OPTIONS: [string, string][] = [["indigo", "#0066df"], ["teal", "#037f75"], ["rose", "#c51b53"]];
const radios = (group: Element): Element[] => group.children as Element[];
const checked = (group: Element): string[] => radios(group).filter((r) => r.attrs["aria-checked"] === "true").map((r) => r.attrs["aria-label"]!);

it("draws one radio per preset, the pick ringed and checked, the rest out of the tab order", () => {
  const onChange = vi.fn();
  const group = form.swatches(OPTIONS, "teal", onChange) as unknown as Element;
  expect(group.attrs.role).toBe("radiogroup");
  expect(radios(group).map((r) => r.attrs.role)).toEqual(["radio", "radio", "radio"]);
  expect(radios(group).map((r) => r.style.background)).toEqual(["#0066df", "#037f75", "#c51b53"]);
  expect(checked(group)).toEqual(["teal"]);
  expect(radios(group).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  const teal = radios(group)[1]!;
  expect(teal.className).toContain("ring-2");
  expect(teal.children.map((c) => (c as Element).tag)).toEqual(["svg"]);
  expect(radios(group)[0]!.children).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

it("moves the pick with the arrows, wrapping, and reports it once per move", () => {
  const onChange = vi.fn();
  const group = form.swatches(OPTIONS, "rose", onChange) as unknown as Element;
  const preventDefault = vi.fn();
  radios(group)[2]!.onkeydown!({ key: "ArrowRight", preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenLastCalledWith("indigo");
  expect(checked(group)).toEqual(["indigo"]);
  expect(radios(group)[0]!.focus).toHaveBeenCalledOnce();
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
