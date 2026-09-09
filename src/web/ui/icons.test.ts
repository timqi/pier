// Shell hydration must retain the elements cached by composer and lightbox.
import html from "./index.html?raw";
import { afterEach, expect, it, vi } from "vitest";
import { Send } from "lucide";
import { icon, initIcons } from "./icons.js";

class Element {
  attrs: Record<string, string> = {};
  children: Element[] = [];
  dataset: Record<string, string> = {};
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; }
  get outerHTML(): string {
    return `<${this.tag} ${Object.entries(this.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}>${this.children.map((c) => c.outerHTML).join("")}</${this.tag}>`;
  }
}

const setup = (slots: Element[] = []) => {
  const createElementNS = vi.fn((_ns: string, tag: string) => new Element(tag));
  const querySelectorAll = vi.fn(() => slots);
  const setProperty = vi.fn();
  vi.stubGlobal("document", { createElementNS, querySelectorAll, documentElement: { style: { setProperty } } });
  return { createElementNS, querySelectorAll, setProperty };
};
afterEach(() => vi.unstubAllGlobals());

it("renders decorative SVG with a shared stroke and no competing accessible name", () => {
  const { createElementNS } = setup();
  const svg = icon(Send) as unknown as Element;
  expect(createElementNS.mock.calls.every(([ns]) => ns === "http://www.w3.org/2000/svg")).toBe(true);
  expect(svg.attrs).toMatchObject({ viewBox: "0 0 24 24", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true", focusable: "false" });
  expect(svg.children.length).toBeGreaterThan(0);
});

it("resolves every HTML slot without replacing cached IDs or hidden classes", () => {
  const slots = [...html.matchAll(/<span\b([^>]*data-icon="([^"]+)"[^>]*)>/g)].map(([, attrs, name]) => {
    const slot = new Element("span");
    slot.dataset.icon = name!;
    for (const [, key, value] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) slot.attrs[key!] = value!;
    return slot;
  });
  const original = slots.map((slot) => ({ slot, attrs: { ...slot.attrs } }));
  const { querySelectorAll, setProperty } = setup(slots);
  initIcons();
  expect(querySelectorAll).toHaveBeenCalledExactlyOnceWith("[data-icon]");
  expect(slots.length).toBeGreaterThan(0);
  for (const { slot, attrs } of original) {
    expect(slots).toContain(slot);
    expect(slot.attrs).toEqual(attrs);
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]!.tag).toBe("svg");
  }
  expect(slots.find((s) => s.attrs.id === "send-queue")!.attrs.class).toContain("hidden");
  expect(slots.find((s) => s.attrs.id === "send-plane")!.attrs.class).not.toContain("hidden");
  const background = decodeURIComponent(setProperty.mock.lastCall![1]);
  expect(background).toContain('stroke="#737373"');
  expect(background).toContain('viewBox="0 0 24 24"');
});

it("reports an unknown shell icon instead of leaving an empty control", () => {
  const slot = new Element("span");
  slot.dataset.icon = "Typo";
  setup([slot]);
  expect(initIcons).toThrow("Unknown shell icon: Typo");
});
