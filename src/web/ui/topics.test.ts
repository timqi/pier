// Topics on index.html: the colour a problem hashes to, and the tag on a row
// with its item's stage while the item is open.
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

it("names an open item's stage on its tags, repainted as it moves, and plain once done", () => {
  const a = add("assistant");
  const b = add("assistant");
  topics.tagRow(a, "auth", vi.fn());
  topics.setTopicStages([{ problem: "auth", stage: "等你确认" }]);
  const tag = (row: HTMLElement) => fake(row).querySelector(".topic-tag")!;
  expect(tag(a).textContent).toBe("auth \u00b7 等你确认");
  expect(tag(a).title).toBe("auth \u00b7 等你确认");
  expect(tag(a).getAttribute("aria-label")).toBe("auth \u00b7 等你确认 \u2014 previous message of this topic");
  // A row tagged later reads the stages already known.
  topics.tagRow(b, "auth", vi.fn());
  expect(tag(b).textContent).toBe("auth \u00b7 等你确认");
  topics.setTopicStages([{ problem: "auth", stage: "merged, restart pending" }]);
  expect([tag(a), tag(b)].map((t) => t.textContent)).toEqual(["auth \u00b7 merged, restart pending", "auth \u00b7 merged, restart pending"]);
  // The same stages again paint nothing: every items refresh calls this.
  const painted = tag(a).children[0];
  topics.setTopicStages([{ problem: "auth", stage: "merged, restart pending" }]);
  expect(tag(a).children[0]).toBe(painted);
  topics.setTopicStages([]);
  expect(tag(a).textContent).toBe("auth");
  expect(tag(a).title).toBe("auth");
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
