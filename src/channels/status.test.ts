import { describe, expect, it } from "vitest";
import { openItemPresentation } from "../core/open-items.js";
import { NOTHING_OPEN } from "../core/types.js";
import { StatusMessage, type StatusView } from "./status.js";

const running = (problem: string): StatusView["snapshot"] =>
  ({ version: 1, items: [openItemPresentation({ problem, stage: "", status: "running", runs: [] }, 0)] });
const view = (text: string, items = text === NOTHING_OPEN ? [] : [text]): StatusView =>
  ({ text, snapshot: { version: 1, items: items.flatMap((p) => running(p).items) } });

const rig = (fail = false) => {
  const posted: string[] = [];
  const logged: string[] = [];
  const status = new StatusMessage<string>((chat, body) => {
    posted.push(`${chat} ${body}`);
    return fail ? Promise.reject(new Error("429")) : Promise.resolve();
  }, (m) => logged.push(m), (v) => `> ${v.text}${v.others?.length ? ` +${String(v.others.length)}` : ""}`);
  return { status, posted, logged };
};

// docs/design/11-im-conversation.md §Status
describe("the status card", () => {
  it("posts a new card on every answer; the API it is given can do nothing else", async () => {
    const { status, posted } = rig();
    expect(await status.answer("D1", view("a"))).toBe(true);
    expect(await status.answer("D1", view("a"))).toBe(true);
    expect(await status.answer("D1", view("b"))).toBe(true);
    expect(posted).toEqual(["D1 > a", "D1 > a", "D1 > b"]);
  });

  it("leaves nothing open to the note, unless another chain has something", async () => {
    const { status, posted } = rig();
    expect(await status.answer("D1", view(NOTHING_OPEN))).toBe(false);
    expect(await status.answer("D1", { ...view(NOTHING_OPEN), others: [] })).toBe(false);
    expect(posted).toEqual([]);
    const others = [{ name: "Design", waiting: 1, inProgress: 0, archived: false }];
    expect(await status.answer("D1", { ...view(NOTHING_OPEN), others })).toBe(true);
    expect(posted).toEqual([`D1 > ${NOTHING_OPEN} +1`]);
  });

  it("a failed post is logged and leaves the answer to the note", async () => {
    const { status, logged } = rig(true);
    expect(await status.answer("D1", view("a"))).toBe(false);
    expect(logged).toEqual(["status: post failed: Error: 429"]);
  });
});
