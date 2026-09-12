// Pinning goes through the shared picker: it offers what is not pinned yet,
// and a pick stages a row — with the reasoning level the picker was left on,
// because a pin never has none — that Save writes.
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import { getJson, sendJson } from "./api.js";
import { openPanel } from "./menu.js";
import { launchField, modelPicker } from "./model-picker.js";
import { createModelMenuPane } from "./model-menu.js";

vi.mock("./api.js", () => ({ failure: vi.fn(async () => "failed"), getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn(), openPanel: vi.fn() }));
vi.mock("./model-picker.js", () => ({
  modelPicker: vi.fn(() => new Element("div")),
  launchField: vi.fn(() => new Element("div")),
}));
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
  attrs: Record<string, string> = {};
  focus = vi.fn();
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
  setAttribute = vi.fn((name: string, value: string) => {
    this.attrs[name] = value;
  });
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
const stored = { ...pinned, thinking: "high" as ThinkingLevel };

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
      url.startsWith("/api/models")
        ? { ok: true, value: [pinned, free] }
        : url.startsWith("/api/config/defaults")
        ? { ok: true, value: { defaultModel: pinned, defaultThinkingLevel: null } }
        : { ok: true, value: { modelMenu: [stored] } },
    ) as never
  );
});

async function pane(): Promise<Element> {
  const built = createModelMenuPane();
  built.load();
  await vi.waitFor(() => expect(getJson).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  return built.el as unknown as Element;
}

it("offers only what is not pinned yet, and a pick stages the row", async () => {
  const el = await pane();
  button(el, "Pin model").onclick!();
  expect(openPanel).toHaveBeenCalledTimes(1);
  const props = vi.mocked(modelPicker).mock.lastCall![0];
  expect(props).toMatchObject({
    models: [free], // the pinned one is not offered a second time
    current: null,
    thinkingLevel: "medium", // the level a new pin starts at
  });
  expect(props.thinkingLevels.length).toBeGreaterThan(0);

  vi.mocked(sendJson).mockResolvedValue(
    { ok: true, json: async () => ({ modelMenu: [stored, { ...free, thinking: "low" }] }) } as unknown as Response,
  );
  props.onThinkingPick("low");
  props.onPick(free);
  expect(el.textContent).toContain("openai/free-model");
  expect(el.textContent).toContain("unsaved changes");

  button(el, "Save menu").onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall).toMatchObject([
    "/api/settings",
    {
      modelMenu: [
        { provider: "anthropic", id: "pinned-model", thinking: "high" },
        { provider: "openai", id: "free-model", thinking: "low" },
      ],
    },
    "PUT",
  ]);
});

it("reorders the menu by the row arrows, ends included, and saves the new order", async () => {
  const second = { ...free, thinking: "low" as ThinkingLevel };
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models")
        ? { ok: true, value: [pinned, free] }
        : url.startsWith("/api/config/defaults")
        ? { ok: true, value: { defaultModel: null, defaultThinkingLevel: null } }
        : { ok: true, value: { modelMenu: [stored, second] } },
    ) as never
  );
  const el = await pane();
  const arrow = (label: string): Element => {
    const found = walk(el).find((e) => e.attrs["aria-label"] === label);
    if (!found) throw new Error(`no arrow: ${label}`);
    return found;
  };
  // The first row cannot go up, the last cannot go down.
  expect(arrow("Move up: anthropic/pinned-model").disabled).toBe(true);
  expect(arrow("Move down: openai/free-model").disabled).toBe(true);

  arrow("Move down: anthropic/pinned-model").onclick!();
  expect(el.textContent).toContain("unsaved changes");
  // Redrawn at its new place: now it is the row that cannot go further down.
  expect(arrow("Move down: anthropic/pinned-model").disabled).toBe(true);

  vi.mocked(sendJson).mockResolvedValue(
    { ok: true, json: async () => ({ modelMenu: [second, stored] }) } as unknown as Response,
  );
  button(el, "Save menu").onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall![1]).toEqual({
    modelMenu: [
      { provider: "openai", id: "free-model", thinking: "low" },
      { provider: "anthropic", id: "pinned-model", thinking: "high" },
    ],
  });
});

it("has nothing to pin once every model is pinned", async () => {
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models")
        ? { ok: true, value: [pinned] }
        : url.startsWith("/api/config/defaults")
        ? { ok: true, value: { defaultModel: null, defaultThinkingLevel: null } }
        : { ok: true, value: { modelMenu: [stored] } },
    ) as never
  );
  const el = await pane();
  expect(button(el, "Pin model").disabled).toBe(true);
});

it("draws the default model from settings.json, writes a change at once and redraws from the answer", async () => {
  const el = await pane();
  const drawn = vi.mocked(launchField).mock.lastCall!;
  expect(drawn[0]).toBe("Default model");
  expect(drawn[1]).toEqual({ model: pinned, thinking: null });
  expect(drawn[2]).toEqual([pinned, free]);

  vi.mocked(sendJson).mockResolvedValue(
    { ok: true, json: async () => ({ defaultModel: free, defaultThinkingLevel: "low" }) } as unknown as Response,
  );
  drawn[3]({ model: free, thinking: "low" });
  await vi.waitFor(() => expect(el.textContent).toContain("Saved"));
  expect(vi.mocked(sendJson).mock.lastCall).toEqual([
    "/api/config/defaults",
    { defaultModel: free, defaultThinkingLevel: "low" },
    "PUT",
  ]);
  expect(vi.mocked(launchField).mock.lastCall![1]).toEqual({ model: free, thinking: "low" });

  // A refused write draws what is stored, not what was asked for.
  vi.mocked(sendJson).mockResolvedValue({ ok: false } as unknown as Response);
  vi.mocked(launchField).mock.lastCall![3]({ model: null, thinking: null });
  await vi.waitFor(() => expect(el.textContent).toContain("failed"));
  expect(vi.mocked(launchField).mock.lastCall![1]).toEqual({ model: free, thinking: "low" });
});
