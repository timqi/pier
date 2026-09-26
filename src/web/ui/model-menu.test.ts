// Pinning goes through the shared picker: it offers the whole catalog, pinned
// models too, and a pick stages a row — with the reasoning level the picker was left on,
// because a pin never has none — that Save writes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import { getJson, sendJson } from "./api.js";
import { openPanel } from "./menu.js";
import { launchField, modelPicker } from "./model-picker.js";
import { createModelMenuPane } from "./model-menu.js";
import { button, fake, installDom, labelled, type FakeElement } from "./dom.testkit.js";

vi.mock("./api.js", () => ({ failure: vi.fn(async () => "failed"), getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn(), openPanel: vi.fn() }));
vi.mock("./model-picker.js", () => ({
  modelPicker: vi.fn(() => document.createElement("div")),
  launchField: vi.fn(() => document.createElement("div")),
}));

const pinned: ModelRef = { provider: "anthropic", id: "pinned-model" };
const free: ModelRef = { provider: "openai", id: "free-model" };
const stored = { ...pinned, thinking: "high" as ThinkingLevel };

beforeEach(() => {
  vi.clearAllMocks();
  installDom();
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

afterEach(() => vi.unstubAllGlobals());

async function pane(): Promise<FakeElement> {
  const built = createModelMenuPane();
  built.load();
  await vi.waitFor(() => expect(getJson).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  return fake(built.el);
}

it("offers the whole catalog, and a pick stages the row", async () => {
  const el = await pane();
  button(el, /Pin model/)!.onclick!();
  expect(openPanel).toHaveBeenCalledTimes(1);
  const props = vi.mocked(modelPicker).mock.lastCall![0];
  expect(props).toMatchObject({
    models: [pinned, free], // a pinned model can be pinned again at another level
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

  button(el, /Save menu/)!.onclick!();
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
  const arrow = (label: string): FakeElement => labelled(el, label)!;
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
  button(el, /Save menu/)!.onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall![1]).toEqual({
    modelMenu: [
      { provider: "openai", id: "free-model", thinking: "low" },
      { provider: "anthropic", id: "pinned-model", thinking: "high" },
    ],
  });
});

it("pins a pinned model again at another level, refusing the same level twice by row", async () => {
  const el = await pane();
  const pick = (thinking: ThinkingLevel, pinnedAt?: ThinkingLevel): void => {
    button(el, /Pin model/)!.onclick!();
    const props = vi.mocked(modelPicker).mock.lastCall![0];
    props.onThinkingPick(thinking);
    props.onPick(pinned, pinnedAt);
  };
  pick("high");
  expect(el.textContent).toContain("anthropic/pinned-model is already pinned at High (row 1)");
  // A pinned row picked in the list takes the dialog's level, not its own.
  pick("low", "high");
  expect(el.textContent).toContain("unsaved changes");
  pick("low");
  expect(el.textContent).toContain("anthropic/pinned-model is already pinned at Low (row 2)");

  vi.mocked(sendJson).mockResolvedValue({ ok: true, json: async () => ({ modelMenu: [] }) } as unknown as Response);
  button(el, /Save menu/)!.onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall![1]).toEqual({
    modelMenu: [
      { provider: "anthropic", id: "pinned-model", thinking: "high" },
      { provider: "anthropic", id: "pinned-model", thinking: "low" },
    ],
  });
});

it("has nothing to pin when the catalog is empty", async () => {
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models")
        ? { ok: false, error: "no catalog" }
        : url.startsWith("/api/config/defaults")
        ? { ok: true, value: { defaultModel: null, defaultThinkingLevel: null } }
        : { ok: true, value: { modelMenu: [stored] } },
    ) as never
  );
  const el = await pane();
  expect(button(el, /Pin model/)!.disabled).toBe(true);
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

it("stages a row's tier from its select and saves it on the entry, none leaving it off", async () => {
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith("/api/models")
        ? { ok: true, value: [pinned, free] }
        : url.startsWith("/api/config/defaults")
        ? { ok: true, value: { defaultModel: null, defaultThinkingLevel: null } }
        : { ok: true, value: { modelMenu: [{ ...stored, tier: "hardest" }, { ...free, thinking: "low" }] } },
    ) as never
  );
  const el = await pane();
  const tiers = el.querySelectorAll("select").filter((s) => s.textContent.includes("tier: none"));
  expect(tiers.map((s) => s.value)).toEqual(["hardest", ""]);
  tiers[0]!.value = "";
  tiers[0]!.onchange!();
  tiers[1]!.value = "cheap";
  tiers[1]!.onchange!();
  expect(el.textContent).toContain("unsaved changes");

  vi.mocked(sendJson).mockResolvedValue({ ok: true, json: async () => ({ modelMenu: [] }) } as unknown as Response);
  button(el, /Save menu/)!.onclick!();
  await vi.waitFor(() => expect(sendJson).toHaveBeenCalled());
  expect(vi.mocked(sendJson).mock.lastCall![1]).toEqual({
    modelMenu: [
      { provider: "anthropic", id: "pinned-model", thinking: "high" },
      { provider: "openai", id: "free-model", thinking: "low", tier: "cheap" },
    ],
  });
});
