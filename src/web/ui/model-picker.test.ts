// Picker regressions: effort survives model selection, and pins replace local favorites.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mustGetJson } from "./api.js";
import { openPanel } from "./menu.js";
import { launchField, modelPicker } from "./model-picker.js";

vi.mock("./api.js", () => ({ mustGetJson: vi.fn() }));
vi.mock("./menu.js", () => ({ openPanel: vi.fn(), closeMenu: vi.fn() }));
vi.mock("./report.js", () => ({ report: vi.fn() }));

class Element {
  children: (Element | string)[] = [];
  classList = { add: vi.fn() };
  className = "";
  value = "";
  name = "";
  checked = false;
  title = "";
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...children: (Element | string)[]) { this.children.push(...children); }
  appendChild(child: Element) { this.append(child); return child; }
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  setAttribute = vi.fn();
  focus = vi.fn();
  get textContent(): string { return this.children.map((c) => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(text: string) { this.children = [text]; }
}
const walk = (el: Element): Element[] => [el, ...el.children.flatMap((c) => typeof c === "string" ? [] : walk(c))];
const models = [{ provider: "test", id: "test-model" }];
const element = (el: HTMLElement): Element => el as unknown as Element;
const button = (root: Element, text: string): Element => walk(root).find((e) => e.tag === "button" && e.textContent.includes(text))!;
function choose(root: Element, level: string): void {
  const radio = walk(root).find((e) => e.tag === "input" && e.value === level)!;
  radio.checked = true;
  radio.onchange!();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
  });
  // Neither cryptographic UUIDs nor browser storage are needed by this control.
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("obsolete favorites read"); } });
  vi.mocked(mustGetJson).mockResolvedValue({ modelMenu: [] });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the newly selected effort when a launch model is chosen afterwards", async () => {
  const onChange = vi.fn();
  const field = element(launchField("Model", { model: null, thinking: "low" }, models, onChange));
  button(field, "Low").onclick!();
  const panel = element(vi.mocked(openPanel).mock.lastCall![1]);
  await vi.waitFor(() => expect(mustGetJson).toHaveBeenCalled());
  choose(panel, "high");
  button(panel, "test-model").onclick!();
  expect(onChange).toHaveBeenLastCalledWith({ model: models[0], thinking: "high" });
});

it("keeps pinned effort and intent while isolating radio groups across pickers", async () => {
  vi.mocked(mustGetJson).mockResolvedValue({ modelMenu: [{ ...models[0], thinking: "high", note: "Complex work" }] });
  const onPick = vi.fn();
  const props = { models, current: models[0], thinkingLevel: "low" as const,
    thinkingLevels: ["low", "high"] as ("low" | "high")[], onPick, onThinkingPick: vi.fn() };
  const first = element(modelPicker(props));
  const second = element(modelPicker(props));
  await vi.waitFor(() => expect(first.textContent).toContain("Pinned"));
  const firstNames = new Set(walk(first).filter((e) => e.name).map((e) => e.name));
  const secondNames = new Set(walk(second).filter((e) => e.name).map((e) => e.name));
  expect(firstNames.size).toBe(1);
  expect(secondNames.size).toBe(1);
  expect([...firstNames].some((name) => secondNames.has(name))).toBe(false);
  expect(first.textContent).not.toMatch(/Starred|[★☆]/);
  const pin = button(first, "test-model");
  expect(pin.title).toBe("Complex work");
  pin.onclick!();
  expect(onPick).toHaveBeenLastCalledWith(models[0], "high");
});
