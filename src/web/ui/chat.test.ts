// The `/status` card on index.html: its run tokens open the runs' sessions,
// live and from a reloaded transcript alike.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { installPage, type FakeDocument } from "./dom.testkit.js";

let doc: FakeDocument;
let chat: typeof import("./chat.js");
const select = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  select.mockClear();
  doc = installPage();
  // Only the tail-follow uses them, and the fake DOM has no layout to follow.
  for (const name of ["ResizeObserver", "MutationObserver"]) vi.stubGlobal(name, class { observe(): void {} });
  chat = await import("./chat.js");
  chat.initChat({
    sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "idle",
    select, showRun: vi.fn(), send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}),
  });
});

afterEach(() => vi.unstubAllGlobals());

const text = [
  "Open",
  "- open items 视图 — lead designing · run 1prwmabc… running 23m · workers: 1 running",
  "- model menu — merged · run gone1 — not in the ledger · run short running 1m",
].join("\n");
const origin: SystemInputOrigin = { kind: "chat-command", command: "status", sessions: { "1prwmabcdefghijk": "s-lead", short: "s-short" } };
const card = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='system']").at(-1)!;
const links = () => card().querySelectorAll("button").filter((b) => b.textContent.startsWith("run "));

it("links every run token whose session the answer carries, and leaves the rest as text", () => {
  chat.appendSystemInput(text, origin);
  expect(card().textContent).toContain("/status");
  expect(card().textContent).toContain(text);
  expect(links().map((b) => b.textContent)).toEqual(["run 1prwmabc…", "run short"]);
  links()[0]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-lead");
  links()[1]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-short");
});

it("draws the same links from a reloaded transcript, and none for an answer without the map", () => {
  chat.renderSnapshot([{ role: "system", text, origin, at: 1 }], "idle", []);
  expect(links().map((b) => b.textContent)).toEqual(["run 1prwmabc…", "run short"]);
  chat.appendSystemInput(text, { kind: "chat-command", command: "status" });
  expect(links()).toEqual([]);
  expect(card().textContent).toContain(text);
});
