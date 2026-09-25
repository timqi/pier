// Shell hydration must retain the elements cached by composer and lightbox.
import html from "./index.html?raw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Plus } from "lucide";
import { icon, initIcons } from "./icons.js";
import { attributes, fake, installDom, walk, type FakeDocument } from "./dom.testkit.js";

let doc: FakeDocument;
beforeEach(() => { doc = installDom(); });
afterEach(() => vi.unstubAllGlobals());

it("renders decorative SVG with a shared stroke and no competing accessible name", () => {
  const svg = fake(icon(Plus));
  expect(walk(svg).every((el) => el.namespaceURI === "http://www.w3.org/2000/svg")).toBe(true);
  expect(attributes(svg)).toMatchObject({ viewBox: "0 0 24 24", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true", focusable: "false" });
  expect(svg.children.length).toBeGreaterThan(0);
});

it("resolves every HTML slot without replacing cached IDs or hidden classes", () => {
  const slots = [...html.matchAll(/<span\b([^>]*data-icon="([^"]+)"[^>]*)>/g)].map(([, attrs, name]) => {
    const slot = doc.createElement("span");
    slot.dataset.icon = name!;
    for (const [, key, value] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) slot.setAttribute(key!, value!);
    return slot;
  });
  doc.body.append(...slots);
  const original = slots.map((slot) => ({ slot, attrs: attributes(slot) }));
  const querySelectorAll = vi.spyOn(doc, "querySelectorAll");
  initIcons();
  expect(querySelectorAll).toHaveBeenCalledExactlyOnceWith("[data-icon]");
  expect(slots.length).toBeGreaterThan(0);
  for (const { slot, attrs } of original) {
    expect(doc.body.children).toContain(slot);
    expect(attributes(slot)).toEqual(attrs);
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]!.localName).toBe("svg");
  }
  expect(slots.find((s) => s.id === "send-queue")!.getAttribute("class")).toContain("hidden");
  expect(slots.find((s) => s.id === "send-arrow")!.getAttribute("class")).not.toContain("hidden");
  const background = decodeURIComponent(doc.documentElement.style.getPropertyValue("--select-chevron"));
  expect(background).toContain('stroke="#737373"');
  expect(background).toContain('viewBox="0 0 24 24"');
});

it("reports an unknown shell icon instead of leaving an empty control", () => {
  const slot = doc.createElement("span");
  slot.dataset.icon = "Typo";
  doc.body.append(slot);
  expect(initIcons).toThrow("Unknown shell icon: Typo");
});
