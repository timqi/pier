// Picker regressions: effort survives model selection, and pins replace local favorites.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mustGetJson } from "./api.js";
import { openPanel } from "./menu.js";
import { launchField, modelPicker } from "./model-picker.js";
import { button, fake, installDom, walk, type FakeElement } from "./dom.testkit.js";

vi.mock("./api.js", () => ({ mustGetJson: vi.fn() }));
vi.mock("./menu.js", () => ({ openPanel: vi.fn(), closeMenu: vi.fn() }));
vi.mock("./report.js", () => ({ report: vi.fn() }));

const models = [{ provider: "test", id: "test-model" }];
function choose(root: FakeElement, level: string): void {
  const radio = walk(root).find((e) => e.localName === "input" && e.value === level)!;
  radio.checked = true;
  radio.onchange!();
}

beforeEach(() => {
  vi.clearAllMocks();
  installDom();
  // Neither cryptographic UUIDs nor browser storage are needed by this control.
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("obsolete favorites read"); } });
  vi.mocked(mustGetJson).mockResolvedValue({ modelMenu: [] });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the newly selected effort when a launch model is chosen afterwards", async () => {
  const onChange = vi.fn();
  const field = fake(launchField("Model", { model: null, thinking: "low" }, models, onChange));
  button(field, /Low/)!.onclick!();
  const panel = fake(vi.mocked(openPanel).mock.lastCall![1]);
  await vi.waitFor(() => expect(mustGetJson).toHaveBeenCalled());
  choose(panel, "high");
  button(panel, /test-model/)!.onclick!();
  expect(onChange).toHaveBeenLastCalledWith({ model: models[0], thinking: "high" });
});

it("keeps pinned effort and intent while isolating radio groups across pickers", async () => {
  vi.mocked(mustGetJson).mockResolvedValue({ modelMenu: [{ ...models[0], thinking: "high", note: "Complex work" }] });
  const onPick = vi.fn();
  const props = { models, current: models[0], thinkingLevel: "low" as const,
    thinkingLevels: ["low", "high"] as ("low" | "high")[], onPick, onThinkingPick: vi.fn() };
  const first = fake(modelPicker(props));
  const second = fake(modelPicker(props));
  await vi.waitFor(() => expect(first.textContent).toContain("Pinned"));
  const firstNames = new Set(walk(first).filter((e) => e.name).map((e) => e.name));
  const secondNames = new Set(walk(second).filter((e) => e.name).map((e) => e.name));
  expect(firstNames.size).toBe(1);
  expect(secondNames.size).toBe(1);
  expect([...firstNames].some((name) => secondNames.has(name))).toBe(false);
  expect(first.textContent).not.toMatch(/Starred|[★☆]/);
  const pin = button(first, /test-model/)!;
  expect(pin.title).toBe("Complex work");
  pin.onclick!();
  expect(onPick).toHaveBeenLastCalledWith(models[0], "high");
});
