// Topics on index.html: the colour a problem hashes to, the tag on a row, the
// filter over the pane's kinds, and the registry the status panel reads.
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

it("tags a row once: one label, under the speaker caption, updated in place", () => {
  const row = add("user");
  const caption = document.createElement("div");
  caption.className = "speaker-line";
  row.append(caption, document.createElement("div"));
  topics.tagRow(row, "auth");
  topics.tagRow(row, "auth review");
  const tags = fake(row).querySelectorAll(".topic-tag");
  expect(tags).toHaveLength(1);
  expect(fake(row).children.indexOf(tags[0]!)).toBe(1);
  expect(tags[0]!.textContent).toBe("auth review");
  expect(tags[0]!.title).toBe("auth review");
  expect(row.dataset.topic).toBe("auth review");
  expect(row.style.getPropertyValue("--topic")).toBe(`oklch(0.62 0.15 ${topics.topicHue("auth review")})`);
});

it("filters the conversation's kinds to one topic and keeps the structure; off shows all", () => {
  const rows = {
    user: add("user", "a"), assistant: add("assistant", "b"), process: add("process", "a"), error: add("error"),
    time: add("time"), activity: add("activity"), divider: add("divider"), pager: add("pager"), trim: add("trim"),
  };
  topics.setTopicFilter("a");
  const hidden = () => Object.entries(rows).filter(([, r]) => r.hidden).map(([k]) => k);
  expect(hidden()).toEqual(["assistant", "error", "time", "activity"]);
  expect(turns().dataset.topicFilter).toBe("a");
  // A row appended under the filter is judged the same way.
  const late = add("system");
  topics.applyTopicFilterTo(late);
  expect(late.hidden).toBe(true);
  // The bar says so, and its × clears it.
  const chip = doc.querySelector(".topic-filter")!;
  expect(chip.nextElementSibling).toBe(doc.querySelector("#status-chip"));
  expect(chip.textContent).toBe("a");
  expect(chip.hidden).toBe(false);
  chip.onclick?.();
  expect(topics.topicFilter()).toBeNull();
  expect(hidden()).toEqual([]);
  expect(chip.hidden).toBe(true);
});

it("records topics in order, the done ones most recently done first, and tells its listener", () => {
  const changed = vi.fn();
  topics.onTopicsChanged(changed);
  for (const p of ["a", "b", "c", "d"]) topics.noteTopic(p);
  topics.noteTopic("c", { done: true });
  topics.noteTopic("a", { done: true });
  topics.noteTopic("a", { done: true });
  expect(changed).toHaveBeenCalledTimes(6);
  expect(topics.seenTopics()).toEqual([
    { problem: "b", done: false }, { problem: "d", done: false }, { problem: "c", done: true }, { problem: "a", done: true },
  ]);
  expect(topics.recentDone()).toEqual(["a", "c"]);
  // Reopened is open again.
  topics.noteTopic("a", { done: false });
  expect(topics.recentDone()).toEqual(["c"]);
  topics.setTopicFilter("c");
  topics.resetTopics();
  expect(topics.seenTopics()).toEqual([]);
  expect(topics.topicFilter()).toBeNull();
});
