// The provider rows share one set of column tracks, so their status columns line up.
import { beforeEach, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../agent/types.js";
import { getJson } from "./api.js";
import { openProviders } from "./providers.js";
import { fake, installDom } from "./dom.testkit.js";

vi.mock("./api.js", () => ({ failure: vi.fn(async () => "failed"), getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./auth-flow.js", () => ({ openAuthFlow: vi.fn() }));

const provider = (id: string, name: string, endpoint: string): ProviderInfo => ({
  id, name, builtin: true, methods: [{ type: "api_key", name: "API key" }], configured: true, stored: "api_key", endpoint,
});

beforeEach(() => {
  vi.clearAllMocks();
  installDom();
  vi.mocked(getJson).mockImplementation((url: string) =>
    Promise.resolve(
      url === "/api/models"
        ? { ok: true, value: [{ provider: "anthropic", id: "claude" }, { provider: "deepseek", id: "chat" }] }
        : { ok: true, value: [provider("anthropic", "Anthropic", "https://a.example"), provider("deepseek", "DeepSeek", "https://deepseek.example/v1")] },
    ) as never
  );
});

it("lays every provider row on the list's own column tracks", async () => {
  const pane = document.createElement("div");
  await openProviders(pane);
  const list = fake(pane).querySelectorAll(".grid-cols-subgrid")[0]!.parentNode!;
  expect(list.className).toContain("grid-cols-[minmax(8rem,1fr)_auto_auto]");
  const rows = list.children as unknown as ReturnType<typeof fake>[];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.classList.contains("grid-cols-subgrid")).toBe(true);
    const cells = row.children[0]!;
    expect(cells.classList.contains("grid-cols-subgrid")).toBe(true);
    expect(cells.children).toHaveLength(3);
    // A fixed-width picker sizes the actions column, so it is one line where it fits.
    const picker = cells.querySelector("select")!;
    expect(picker.classList.contains("w-36")).toBe(true);
    expect(picker.classList.contains("w-full")).toBe(false);
  }
});
