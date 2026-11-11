// The Charter dialog opens before its read lands, saves only a change within
// the limit, asks before unsaved text goes, and keeps the text a failed save refused.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Charter } from "../types.js";
import { button, fake, installDom, labelled, walk, type FakeElement } from "./dom.testkit.js";

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }));
vi.mock("./api.js", () => api);
const confirm = vi.fn(() => true);

let ui: typeof import("./charter.js");

beforeEach(async () => {
  installDom();
  vi.stubGlobal("window", { confirm });
  ui = await import("./charter.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const chain = { id: "c1", name: "Parsers" };
const area = (dialog: FakeElement): FakeElement => labelled(dialog, "Charter of Parsers")!;
const type = (dialog: FakeElement, text: string): void => {
  area(dialog).value = text;
  area(dialog).oninput?.(new Event("input"));
};
const alert = (dialog: FakeElement): FakeElement => walk(dialog).find((el) => el.getAttribute("role") === "alert")!;
/** Esc at the key, where the dialog takes it; a `cancel` is any other close request. */
const esc = (dialog: FakeElement): Event => {
  const ev = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", isComposing: false });
  dialog.dispatchEvent(ev);
  return ev;
};

/** Opened on a read of `text`, landed. */
async function opened(text = "Focus: parsers"): Promise<FakeElement> {
  api.getJson.mockResolvedValue({ ok: true, value: { text } satisfies Charter });
  const dialog = fake(ui.openCharter(chain));
  await vi.waitFor(() => expect(area(dialog).disabled).toBe(false));
  return dialog;
}

it("opens at once on the chain's file, and saves nothing until the text changes", async () => {
  let land: (got: { ok: true; value: Charter }) => void = () => {};
  api.getJson.mockReturnValue(new Promise((resolve) => (land = resolve)));
  const dialog = fake(ui.openCharter(chain));
  expect(dialog.open).toBe(true);
  expect(api.getJson).toHaveBeenCalledWith("/api/chains/c1/charter", expect.any(String));
  expect(dialog.textContent).toContain("Parsers");
  expect(dialog.textContent).toContain("chains/c1/AGENTS.md · read by this chain's main session from its next session");
  expect(area(dialog).disabled).toBe(true);
  expect(area(dialog).placeholder).toBe("Focus: …\nDefault repo: …\nSkills: …\nModels: …");
  // CONTROL's size, swapped for a phone's: a CONTROL of another size would leave the swap undone, and iOS zooming.
  expect(area(dialog).className.split(" ").filter((c) => c.includes("text-"))).toEqual(["text-base", "md:text-[12.5px]", "placeholder:text-neutral-400"]);
  expect(button(dialog, "Save")!.disabled).toBe(true);

  land({ ok: true, value: { text: "Focus: parsers" } });
  await vi.waitFor(() => expect(area(dialog).value).toBe("Focus: parsers"));
  expect(dialog.textContent).toContain("14 / 4000");
  expect(button(dialog, "Save")!.disabled).toBe(true);
  type(dialog, "Focus: lexers");
  expect(button(dialog, "Save")!.disabled).toBe(false);
  type(dialog, "Focus: parsers");
  expect(button(dialog, "Save")!.disabled).toBe(true);
});

it("disables Save past the limit and counts in red", async () => {
  const dialog = await opened();
  type(dialog, "x".repeat(4001));
  expect(button(dialog, "Save")!.disabled).toBe(true);
  const count = walk(dialog).find((el) => el.textContent === "4001 / 4000")!;
  expect(count.classList.contains("text-red-600")).toBe(true);
  type(dialog, "x".repeat(4000));
  expect(button(dialog, "Save")!.disabled).toBe(false);
});

it("saves on ⌘/Ctrl+↵, closes and tells whether a head keeps the old charter", async () => {
  const saved = vi.fn();
  ui.onCharterSaved(saved);
  const dialog = await opened();
  api.postJson.mockResolvedValue({ ok: true, value: { text: "Focus: lexers", head: true } satisfies Charter });
  type(dialog, "Focus: lexers");
  const ev = { key: "Enter", ctrlKey: true, metaKey: false, preventDefault: vi.fn() };
  area(dialog).onkeydown?.(ev as unknown as Event);
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(api.postJson).toHaveBeenCalledWith("/api/chains/c1/charter", { text: "Focus: lexers" }, expect.any(String), "PUT");
  expect(ev.preventDefault).toHaveBeenCalled();
  expect(saved).toHaveBeenCalledWith("c1", true);
  expect(confirm).not.toHaveBeenCalled();
});

it("keeps the text a failed save refused, the reason in the dialog", async () => {
  const saved = vi.fn();
  ui.onCharterSaved(saved);
  const dialog = await opened();
  api.postJson.mockResolvedValue({ ok: false, error: "charter: 4001 characters — at most 4000" });
  type(dialog, "Focus: lexers");
  button(dialog, "Save")!.click();
  await vi.waitFor(() => expect(alert(dialog).textContent).toBe("charter: 4001 characters — at most 4000"));
  expect(alert(dialog).classList.contains("hidden")).toBe(false);
  expect(dialog.open).toBe(true);
  expect(area(dialog).value).toBe("Focus: lexers");
  expect(button(dialog, "Save")!.disabled).toBe(false);
  expect(saved).not.toHaveBeenCalled();
});

it("asks before Esc, ✕ or Cancel drop unsaved text, and closes at once when there is none", async () => {
  const clean = await opened();
  const ev = esc(clean);
  expect(ev.defaultPrevented).toBe(true);
  expect(clean.open).toBe(false);
  expect(confirm).not.toHaveBeenCalled();

  const dialog = await opened();
  type(dialog, "Focus: lexers");
  confirm.mockReturnValueOnce(false);
  esc(dialog);
  expect(confirm).toHaveBeenCalledWith("Discard the unsaved charter of Parsers?");
  expect(dialog.open).toBe(true);
  confirm.mockReturnValueOnce(false);
  // Chrome's second Esc, its `cancel` no longer refusable, never gets that far.
  esc(dialog);
  expect(dialog.open).toBe(true);
  const back = new Event("cancel", { cancelable: true });
  confirm.mockReturnValueOnce(false);
  dialog.dispatchEvent(back);
  expect(back.defaultPrevented).toBe(true);
  expect(dialog.open).toBe(true);
  confirm.mockReturnValueOnce(false);
  labelled(dialog, "Close charter")!.click();
  button(dialog, "Cancel")!.click();
  expect(dialog.open).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(5);
});

it("says a charter it could not read and offers nothing to save over it", async () => {
  api.getJson.mockResolvedValue({ ok: false, error: "charter: chains/c1/AGENTS.md could not be read: EACCES" });
  const dialog = fake(ui.openCharter(chain));
  await vi.waitFor(() => expect(alert(dialog).textContent).toContain("EACCES"));
  expect(area(dialog).disabled).toBe(true);
  expect(button(dialog, "Save")!.disabled).toBe(true);
});
