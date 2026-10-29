// The item view on the real pane: the turns route's rows drawn as the pane draws a
// session, and live rows shown or hidden by the pane's own tagging.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withItem } from "../../core/identity.js";
import { installPage, type FakeDocument, type FakeElement } from "./dom.testkit.js";
import type { ItemTurns } from "./item-view.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("./highlight.js", () => ({ highlightCode: async () => {} }));

let doc: FakeDocument;
let chat: typeof import("./chat.js");
let view: typeof import("./item-view.js");
const itemView = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  itemView.mockClear();
  doc = installPage();
  for (const name of ["ResizeObserver", "MutationObserver"]) vi.stubGlobal(name, class { observe(): void {} });
  chat = await import("./chat.js");
  view = await import("./item-view.js");
  chat.initChat({
    sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "idle",
    select: vi.fn(), openItem: vi.fn(), send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}), quote: vi.fn(),
    itemView, item: () => "auth",
  });
});
afterEach(() => vi.unstubAllGlobals());

const pane = () => doc.querySelector("#turns")!;
const shown = () => pane().children.filter((r) => !r.hasAttribute("data-item-hidden") && r.dataset.kind !== "time");
const text = (r: FakeElement) => r.textContent;

const turns: ItemTurns = {
  problem: "auth", aliases: ["login"], epoch: "ep", lastSeq: 9,
  sessions: [
    { sessionId: "h0", startedAt: 1, turns: [
      { index: 0, turn: { role: "user", text: "fix login", at: 1 } },
      { index: 1, turn: { role: "assistant", text: "On it.\n<open>login — worker running</open>" } },
    ] },
    { sessionId: "h1", startedAt: 2, turns: [
      { index: 0, turn: { role: "system", text: "seed", origin: { kind: "session-seed", reason: "idle", previousSessionId: "h0" } } },
      { index: 3, turn: { role: "user", text: withItem("auth", "status?"), at: 3 } },
      { index: 4, turn: { role: "assistant", text: "Running.\n<topic>auth</topic>" } },
    ] },
  ],
};

it("draws each session's rows, then shows only the live rows tagged with a key, hiding the rest in place", () => {
  const filter = view.renderItem(turns, "h1", "idle", []);
  const drawn = pane().children.length;
  expect(pane().querySelectorAll("[data-kind='user']").map(text)).toEqual(["loginfix login", "authstatus?"]); // tag, then text
  // The stamped turn reads without its item line and carries the item's tag instead.
  const stamped = pane().querySelectorAll("[data-kind='user']")[1]!;
  expect(stamped.querySelector(".topic-tag")!.textContent).toBe("auth");
  expect(pane().querySelector("[data-kind='divider']")).not.toBeNull();
  // Another item's exchange arrives on the head's stream: in the pane, not shown.
  chat.appendTurn("user", "deploy now?", false, 10 * 3_600_000); // after a gap: a clock above it
  filter();
  chat.completeTurn("Deploying.\n<topic>deploy</topic>");
  filter();
  // The view's own send shows at once, and the reply in flight under it.
  chat.appendTurn("user", withItem("auth", "and the tests?"), false, 11);
  filter();
  chat.appendDelta("Checking");
  filter();
  expect(shown().at(-1)!.dataset.kind).toBe("assistant");
  chat.completeTurn("Green.\n<topic>login</topic>");
  filter();
  chat.appendDivider("full", 12);
  filter();
  expect(pane().children.length).toBeGreaterThan(drawn + 4);
  const live = shown().slice(-3);
  expect(live.map((r) => r.dataset.kind)).toEqual(["user", "assistant", "divider"]);
  expect(text(live[0]!)).toContain("and the tests?");
  expect(text(live[1]!)).toContain("Green.");
  const hidden = pane().children.filter((r) => r.hasAttribute("data-item-hidden"));
  expect(hidden.filter((r) => r.dataset.kind !== "time").map(text).join()).toMatch(/deploy now\?.*Deploying\./);
  // A clock stamps the row after it: hidden with the other item's message.
  expect(hidden.some((r) => r.dataset.kind === "time")).toBe(true);
  // The tag on a view's row opens the view, edit is off: its rewind would drop rows the view hides.
  live[0]!.querySelector(".topic-tag")!.onclick!();
  expect(itemView).toHaveBeenCalledWith("auth");
  expect(pane().querySelectorAll("[data-kind='user']").flatMap((r) => r.querySelectorAll("button")).some((b) => b.title.startsWith("Edit"))).toBe(false);
});

it("says when the item has no rows on disk, and names an unknown one with the way back", () => {
  view.renderItem({ ...turns, sessions: [{ sessionId: "h1", startedAt: 1, turns: [] }] }, "h1", "idle", []);
  expect(text(pane())).toContain('Nothing of "auth" in its sessions\' transcripts.');
  chat.resetChat();
  const back = vi.fn();
  view.itemMissing('No item "nope"', back);
  expect(text(pane())).toContain('No item "nope"');
  pane().querySelector("button")!.onclick!(new Event("click") as MouseEvent);
  expect(back).toHaveBeenCalled();
});
