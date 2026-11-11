// Settings' topic strip: the open tab is brought into a phone's sideways-scrolling strip on open and on every switch.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, FakeElement, installPage } from "./dom.testkit.js";

const pane = () => ({ el: document.createElement("div"), show: vi.fn(), hide: vi.fn(), load: vi.fn(async () => false) });
vi.mock("./channels.js", () => ({ createChannelsView: pane }));
vi.mock("./config.js", () => ({ createConfigView: pane }));
vi.mock("./model-menu.js", () => ({ createModelMenuPane: pane }));
vi.mock("./notifications.js", () => ({ createNotificationsCard: pane }));
vi.mock("./passkeys.js", () => ({ createPasskeysCard: pane }));
vi.mock("./providers.js", () => ({ openProviders: vi.fn() }));
vi.mock("./tasks.js", () => ({ createTasksPane: pane }));
vi.mock("./vault.js", () => ({ createVaultPane: pane }));
vi.mock("./shortcut.js", () => ({ escapeKey: vi.fn() }));

let scrolled: FakeElement[];
beforeEach(() => {
  vi.resetModules();
  installPage();
  vi.stubGlobal("localStorage", { getItem: () => "security", setItem: vi.fn() });
  scrolled = [];
  vi.spyOn(FakeElement.prototype, "scrollIntoView").mockImplementation(function (this: FakeElement) { scrolled.push(this); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("scrolls the open tab into the strip when Settings opens and when the topic changes", async () => {
  const { createSettingsView } = await import("./settings.js");
  const root = document.createElement("div");
  const view = createSettingsView(root, vi.fn(), vi.fn(), vi.fn());
  view.show("tasks");
  expect(scrolled.map((t) => [t.textContent, t.getAttribute("aria-current")])).toEqual([["Tasks", "page"]]);
  view.show("vault");
  expect(scrolled.at(-1)?.textContent).toBe("Vault");
  // No topic in the route: the one Settings was left on.
  view.show();
  expect(fake(scrolled.at(-1)).textContent).toBe("Vault");
});
