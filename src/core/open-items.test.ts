import { describe, expect, it } from "vitest";
import { withItem } from "./identity.js";
import { itemTurns } from "./open-items.js";
import type { ChatTurn } from "./types.js";

const user = (text: string): ChatTurn => ({ role: "user", text });
const reply = (text: string): ChatTurn => ({ role: "assistant", text });
const callback = (runId: string, runIds?: string[]): ChatTurn =>
  ({ role: "system", text: `result of ${runId}`, origin: { kind: "task-callback", taskId: "t", runId, sourceSessionId: null, ...(runIds ? { runIds } : {}) } });
const seed: ChatTurn = { role: "system", text: "[Pier: a new session]", origin: { kind: "session-seed", reason: "full", previousSessionId: "h1" } };

describe("itemTurns", () => {
  // Two items worked at once across a rotation: `menu` (reworded from `menu bar`) and `CI`.
  const h1: ChatTurn[] = [
    seed,
    user("[Ada<U1> 12:00 lang=en]\nfix the menu bar"),
    reply("On it.\n<open>menu bar — worker running (run r1)</open>"),
    user("and CI is red"),
    reply("Looking.\n<open>CI — worker running (run r2)</open>"),
    callback("r1"),
    reply("Fixed; next phase.\n<done>menu bar → menu</done>\n<open>menu — building v2 (run r3)</open>"),
    callback("r2"),
    reply("CI green.\n<done>CI</done>"),
    { role: "system", text: "Waiting on you · 1", origin: { kind: "chat-command", command: "status" } },
  ];
  const h2: ChatTurn[] = [
    seed,
    callback("r9", ["r3"]),
    reply("v2 built.\n<topic>menu</topic>"),
    user(withItem("menu", "ship it")),
    reply("Shipping.\n<open>CI — rerun (run r4)</open>"),
    callback("r4"),
    user("unrelated chat"),
    reply("Sure."),
  ];

  it("keeps an item's replies, the user turns they answer, its callbacks and every divider", () => {
    const view = itemTurns([{ sessionId: "h1", turns: h1 }, { sessionId: "h2", turns: h2 }], ["menu", "menu bar"], []);
    expect(view.map((s) => [s.sessionId, s.turns.map((t) => t.index)])).toEqual([
      ["h1", [0, 1, 2, 5, 6]],
      ["h2", [0, 1, 2, 3]],
    ]);
    expect(view[0]!.turns[1]!.turn).toBe(h1[1]);
  });

  it("keeps the other item's rows apart, its runs the item's own or opened in the chain", () => {
    const view = itemTurns([{ sessionId: "h1", turns: h1 }, { sessionId: "h2", turns: h2 }], ["CI"], ["r0"]);
    // A kept reply's message is shown whatever item its line named: the reply answers it.
    expect(view.map((s) => s.turns.map((t) => t.index))).toEqual([[0, 3, 4, 7, 8], [0, 3, 4, 5]]);
    // A run the item's `run_ids` hold, with no `<open>` naming it in the transcript.
    expect(itemTurns([{ sessionId: "h3", turns: [callback("r0")] }], ["CI"], ["r0"])[0]!.turns.map((t) => t.index)).toEqual([0]);
  });

  it("keeps an unmarked reply its kept callback leads to, as the pane tags it, and none past a user turn", () => {
    const turns: ChatTurn[] = [
      user("go"), callback("r0"), { role: "system", text: "Waiting on you · 1", origin: { kind: "chat-command", command: "status" } },
      reply("Merged."), callback("r5"), reply("Unrelated run done."), callback("r0"), user("and?"), reply("Nothing more."),
    ];
    expect(itemTurns([{ sessionId: "h1", turns }], ["CI"], ["r0"])[0]!.turns.map((t) => t.index)).toEqual([1, 3, 6]);
  });
});
