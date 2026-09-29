// Topics on index.html: the colour a problem hashes to, and the tag on a row
// dotted while its item waits on the user, until they answer.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, installPage, type FakeDocument } from "./dom.testkit.js";

let doc: FakeDocument;
let topics: typeof import("./topics.js");

beforeEach(async () => {
  vi.resetModules();
  doc = installPage();
  topics = await import("./topics.js");
});
afterEach(() => vi.unstubAllGlobals());

const turns = () => doc.querySelector("#turns")!;
const add = (kind: string, topic?: string): HTMLElement => {
  const row = document.createElement("div");
  row.dataset.kind = kind;
  if (topic) row.dataset.topic = topic;
  turns().append(fake(row));
  return row;
};

it("hashes a problem to one hue in range, the same every time", () => {
  const hue = topics.topicHue("auth review");
  expect(hue).toBe(topics.topicHue("auth review"));
  for (const p of ["", "a", "子任务 thread", "x".repeat(500)]) {
    expect(topics.topicHue(p)).toBeGreaterThanOrEqual(0);
    expect(topics.topicHue(p)).toBeLessThan(360);
  }
  expect(topics.topicHue("a")).not.toBe(topics.topicHue("b"));
});

it("tags a row once: one label, under the speaker caption, updated in place, its colour on the tag alone", () => {
  const row = add("user");
  const caption = document.createElement("div");
  caption.className = "speaker-line";
  row.append(caption, document.createElement("div"));
  const jump = vi.fn();
  topics.tagRow(row, "auth", jump);
  topics.tagRow(row, "auth review", jump);
  const tags = fake(row).querySelectorAll(".topic-tag");
  expect(tags).toHaveLength(1);
  expect(fake(row).children.indexOf(tags[0]!)).toBe(1);
  expect(tags[0]!.textContent).toBe("auth review");
  expect(tags[0]!.title).toBe("auth review");
  expect(row.dataset.topic).toBe("auth review");
  expect(tags[0]!.style.getPropertyValue("--topic")).toBe(`oklch(0.62 0.15 ${topics.topicHue("auth review")})`);
  expect(row.style.getPropertyValue("--topic")).toBe("");
  tags[0]!.onclick!();
  expect(jump).toHaveBeenCalledWith(row);
});

it("names only the problem, dotted while its item waits on the user and they have not answered", () => {
  const a = add("assistant");
  topics.tagRow(a, "auth", vi.fn());
  const tag = (row: HTMLElement) => fake(row).querySelector(".topic-tag")!;
  const dotted = () => fake(turns()).querySelectorAll(".topic-tag").map((t) => t.hasAttribute("data-waiting"));
  topics.setOpenTopics([{ problem: "auth", status: "running", runs: [] }]);
  expect(tag(a).textContent).toBe("auth");
  expect(dotted()).toEqual([false]);
  topics.setOpenTopics([{ problem: "auth", status: "waiting on you", runs: [] }]);
  expect(tag(a).textContent).toBe("auth");
  expect(tag(a).title).toBe("auth \u00b7 waiting on you");
  expect(tag(a).getAttribute("aria-label")).toBe("auth \u00b7 waiting on you \u2014 previous message of this topic");
  expect(dotted()).toEqual([true]);
  // A row tagged later is dotted by the next refresh, the tag's owner (chat.ts) calling it.
  const b = add("assistant");
  topics.tagRow(b, "auth", vi.fn());
  topics.refreshTopicTags();
  expect(dotted()).toEqual([true, true]);
  // No longer waiting, or done: gone at once.
  topics.setOpenTopics([{ problem: "auth", status: "pending release", runs: [] }]);
  expect(dotted()).toEqual([false, false]);
  expect(tag(a).title).toBe("auth");
  topics.setOpenTopics([{ problem: "auth", status: "waiting on you", runs: [] }]);
  topics.setOpenTopics([]);
  expect(dotted()).toEqual([false, false]);
});

it("drops the dot once the user answers the topic's newest reply, and a later reply of it asks again", () => {
  const dotted = () => fake(turns()).querySelectorAll(".topic-tag").map((t) => t.hasAttribute("data-waiting"));
  const reply = (topic?: string) => {
    const row = add("assistant");
    if (topic) topics.tagRow(row, topic, vi.fn());
    return row;
  };
  reply("auth");
  topics.setOpenTopics([{ problem: "auth", status: "waiting on you", runs: [] }, { problem: "ci", status: "waiting on you", runs: [] }]);
  expect(dotted()).toEqual([true]);
  // The first thing said after the topic's reply answers it.
  add("user");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false]);
  // The topic asks again: every tag of it is the topic's, dotted alike.
  reply("auth");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([true, true]);
  // A message after another topic's reply answers that one, not this one...
  reply("ci");
  add("user");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([true, true, false]);
  // ...unless it quotes a row of this one (a Reply, or an option pick).
  reply();
  add("user").dataset.answers = "auth";
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false, false, false]);
  // The chain rotating in between does not: the answer after the divider still counts.
  reply("auth");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([true, true, false, true]);
  add("divider");
  add("user");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false, false, false, false]);
});

it("keeps an answered topic's dot off through a live reply of it until the items read after that reply", () => {
  const dotted = () => fake(turns()).querySelectorAll(".topic-tag").map((t) => t.hasAttribute("data-waiting"));
  topics.tagReply(add("assistant"), "Which?\n<open>auth — waiting on you: 60K or 80K?</open>", vi.fn());
  topics.setOpenTopics([{ problem: "auth", status: "waiting on you", runs: [] }]);
  add("user");
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false]);
  // The reply lands before the items it changed: the old `waiting on you` is not it asking again.
  topics.tagReply(add("assistant"), "On it.\n<open>auth — worker running</open>", vi.fn(), true);
  // The user message it answers inherits the tag.
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false, false, false]);
  topics.setOpenTopics([{ problem: "auth", status: "running", runs: [] }]);
  expect(dotted()).toEqual([false, false, false]);
  // A live reply that does ask again is dotted by the items that say so.
  topics.tagReply(add("assistant"), "Again?\n<open>auth — waiting on you: 70K?</open>", vi.fn(), true);
  topics.refreshTopicTags();
  expect(dotted()).toEqual([false, false, false, false]);
  topics.setOpenTopics([{ problem: "auth", status: "waiting on you", runs: [] }]);
  expect(dotted()).toEqual([true, true, true, true]);
});

it("tags a reply by its marker and the user message it answers, and nothing past the reply before", () => {
  const u0 = add("user");
  const a0 = add("assistant");
  const u1 = add("user");
  const a1 = add("assistant");
  topics.tagReply(a1, "Merged.\n<done>auth</done>", vi.fn());
  expect([u0, a0, u1, a1].map((r) => r.dataset.topic)).toEqual([undefined, undefined, "auth", "auth"]);
  topics.tagReply(a0, "Plain.", vi.fn());
  expect(a0.dataset.topic).toBeUndefined();
});

it("tags a reply naming no topic by the item holding a run of the nearest callback above it, up to a user row or another reply", () => {
  const cause = (runs: string, into?: HTMLElement): HTMLElement => {
    const chip = document.createElement("div");
    chip.dataset.kind = "system";
    chip.dataset.runs = runs;
    if (into) fake(into).append(fake(chip));
    else turns().append(fake(chip));
    return chip;
  };
  topics.setOpenTopics([
    { problem: "auth", status: "running", runs: [{ runId: "r1" }] },
    { problem: "ci", status: "running", runs: [{ runId: "r3" }] },
  ]);
  // The callback's chip in the reply's own bubble; a batch reads each of its runs.
  const a0 = add("assistant");
  cause("r2,r3", a0);
  topics.tagReply(a0, "Done.", vi.fn());
  expect(a0.dataset.topic).toBe("ci");
  // A marker wins over the callback.
  const a1 = add("assistant");
  cause("r1", a1);
  topics.tagReply(a1, "Other.\n<topic>deploy</topic>", vi.fn());
  expect(a1.dataset.topic).toBe("deploy");
  // Above the bubble, only the nearest callback counts, and no user message inherits.
  const u = add("user");
  cause("r3");
  cause("r1");
  const a2 = add("assistant");
  topics.tagReply(a2, "Ok.", vi.fn());
  expect([u.dataset.topic, a2.dataset.topic]).toEqual([undefined, "auth"]);
  // A user row or another reply ends the search; a run no open item holds tags nothing.
  cause("r1");
  add("user");
  const a3 = add("assistant");
  topics.tagReply(a3, "Hm.", vi.fn());
  const a4 = add("assistant");
  topics.tagReply(a4, "Hm.", vi.fn());
  const a5 = add("assistant");
  cause("r9", a5);
  topics.tagReply(a5, "Hm.", vi.fn());
  expect([a3, a4, a5].map((r) => r.dataset.topic)).toEqual([undefined, undefined, undefined]);
  // Rebuilt from the items: once auth closes, its run tags nothing.
  topics.setOpenTopics([]);
  const a6 = add("assistant");
  cause("r1", a6);
  topics.tagReply(a6, "Late.", vi.fn());
  expect(a6.dataset.topic).toBeUndefined();
});
