// The dialog opens before the read lands, draws one block per source, and
// copies the whole text — never a block's share of it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SystemPrompt } from "../../core/types.js";
import { button, fake, installDom, walk } from "./dom.testkit.js";

const api = vi.hoisted(() => ({ mustGetJson: vi.fn() }));
vi.mock("./api.js", () => api);
const clipboard = vi.hoisted(() => ({ written: [] as string[] }));

const prompt: SystemPrompt = {
  text: "base\n\n<project_context>…</project_context>",
  tokens: 1234,
  blocks: [
    { label: "Pier baseline", text: "base" },
    { label: "Role prompt", path: "<pier>/worker.md", text: "# You are a worker" },
  ],
};

let ui: typeof import("./system-prompt.js");

beforeEach(async () => {
  installDom();
  vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void clipboard.written.push(t) } });
  ui = await import("./system-prompt.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clipboard.written.length = 0;
});

const session = { id: "s1", title: "fix parser", cwd: "/w" };

it("opens at once, then shows the blocks, the total and a copy of the whole", async () => {
  let land: (p: SystemPrompt) => void = () => {};
  api.mustGetJson.mockReturnValue(new Promise<SystemPrompt>((resolve) => (land = resolve)));
  const dialog = fake(ui.openSystemPrompt(session));
  expect(dialog.open).toBe(true);
  expect(api.mustGetJson).toHaveBeenCalledWith("/api/sessions/s1/system-prompt", expect.any(String));
  expect(dialog.textContent).toContain("Loading…");
  const copy = button(dialog, "Copy")!;
  expect(copy.disabled).toBe(true);

  land(prompt);
  await vi.waitFor(() => expect(copy.disabled).toBe(false));
  expect(dialog.textContent).toContain("~1.2k tokens · 2 blocks");
  expect(walk(dialog).filter((el) => el.localName === "h3").map((el) => el.textContent)).toEqual(["Pier baseline", "Role prompt"]);
  expect(walk(dialog).filter((el) => el.localName === "pre").map((el) => el.textContent)).toEqual(["base", "# You are a worker"]);
  expect(dialog.textContent).toContain("<pier>/worker.md");
  await copy.onclick?.(new Event("click"));
  expect(clipboard.written).toEqual([prompt.text]);

  walk(dialog).find((el) => el.getAttribute("aria-label") === "Close system prompt")!.onclick?.(new Event("click"));
  expect(dialog.open).toBe(false);
});

it("says why it has nothing to show", async () => {
  api.mustGetJson.mockRejectedValue(new Error("No request has carried a system prompt yet"));
  const dialog = fake(ui.openSystemPrompt(session));
  await vi.waitFor(() => expect(walk(dialog).some((el) => el.getAttribute("role") === "alert")).toBe(true));
  expect(dialog.textContent).toContain("No request has carried a system prompt yet");
  expect(button(dialog, "Copy")!.disabled).toBe(true);
});
