// Pinning goes through the shared picker: it offers what is not pinned yet,
// and a pick stages a row that Save writes.
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelRef } from "../../core/types.js";
import { getJson, sendJson } from "./api.js";
import { openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
import { createModelMenuPane } from "./model-menu.js";

vi.mock("./api.js", () => ({ failure: vi.fn(async () => "failed"), getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn(), openPanel: vi.fn() }));
vi.mock("./model-picker.js", () => ({ modelPicker: vi.fn(() => new Element("div")) }));
vi.mock("./icons.js", () => ({ icon: () => new Element("svg") }));

class Element {
  children: (Element | string)[] = [];
  className = "";
  value = "";
  type = "";
  placeholder = "";
  title = "";
  disabled = false;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  classList = { add: vi.fn(), remove: vi.fn(), replace: vi.fn(), toggle: vi.fn() };
  constructor(readonly tag: string) {}
  append(...kids: (Element | string)[]): void {
    this.children.push(...kids);
  }
  prepend(...kids: (Element | string)[]): void {
    this.children.unshift(...kids);
  }
  replaceChildren(...kids: (Element | string)[]): void {
    this.children = kids;
  }
  setAttribute = vi.fn();
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(text: string) {
    this.children = [text];
  }
}

const walk = (el: Element): Element[] => [el, ...el.children.flatMap((c) => (typeof c === "string" ? [] : walk(c)))];
const button = (root: Element, text: string): Element => {
  const found = walk(root).find((e) => e.tag === "button" && e.textContent.includes(text));
  if (!found) throw new Error(`no button: ${text}`);
  return found;
};

const pinned: ModelRef = { provider: "anthropic", id: "pinned-model" };
const free: ModelRef = { provider: "openai", id: "free-model" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
  });
  vi.stubGlobal("Option", class extends Element {
    constructor(label = "") {
      super("option");
      this.textContent = label;
    }
  });
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models") ? { ok: true, value: [pinned, free] } : { ok: true, value: { modelMenu: [pinned] } },
    ) as never
  );
});

async function pane(): Promise<Element> {
  const built = createModelMenuPane();
  built.load();
  await vi.waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  return built.el as unknown as Element;
}

it("offers only what is not pinned yet, and a pick stages the row", async () => {
  const el = await pane();
  button(el, "Pin model").onclick!();
  expect(openPanel).toHaveBeenCalledTimes(1);
  expect(vi.mocked(modelPicker).mock.lastCall![0]).toMatchObject({
    models: [free], // the pinned one is not offered a second time
    current: null,
    thinkingLevels: [], // this pane picks models; reasoning is the row's own field
  });

  vi.mocked(sendJson).mockResolvedValue(
    { ok: true, json: async () => ({ modelMenu: [pinned, free] }) } as unknown as Response,
  );
  vi.mocked(modelPicker).mock.lastCall![0].onPick(free);
  expect(el.textContent).toContain("openai/free-model");
  expect(el.textContent).toContain("unsaved changes");

  button(el, "Save menu").onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall).toMatchObject([
    "/api/settings",
    { modelMenu: [{ provider: "anthropic", id: "pinned-model" }, { provider: "openai", id: "free-model" }] },
    "PUT",
  ]);
});

it("has nothing to pin once every model is pinned", async () => {
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models")
        ? { ok: true, value: [pinned] }
        : { ok: true, value: { modelMenu: [pinned] } },
    ) as never
  );
  const el = await pane();
  expect(button(el, "Pin model").disabled).toBe(true);
});
