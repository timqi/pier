import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISPATCHER, lead, RUN_RESULT, WORKER, WORKER_TOOL_CALLS } from "../agent/roles.js";
import { MILESTONE } from "./callbacks.js";
import { fixPrompt, reviewPrompt } from "./goals.js";

// docs/design/10-continuous-session.md §Prompt vocabulary is the contract; this
// test reads its `Not` column so the doc and the prompts cannot drift apart.
const root = join(import.meta.dirname, "..", "..");
const doc = readFileSync(join(root, "docs/design/10-continuous-session.md"), "utf8");
const table = doc.split("### Prompt vocabulary")[1]?.split("\n### ")[0] ?? "";
const banned = table.split("\n")
  .filter((line) => line.startsWith("| ") && !line.startsWith("| Word") && !line.startsWith("| ---"))
  .flatMap((line) => (line.split("|")[3] ?? "").split(","))
  .map((word) => word.replace(/\(.*?\)/g, "").trim())
  .filter((word) => word && word !== "—");

// Every `[Pier: …]` note Pier writes into a session, wherever it is built.
const notes = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === "ui" ? [] : notes(path);
  if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.includes("[Pier: "))
    .map((line) => line.slice(line.indexOf("[Pier: ")));
});

const tree = { head: "abc1234", branch: "feat", base: "main", baseSha: "def5678", clean: true };
const prompts: Record<string, string> = {
  DISPATCHER, WORKER, WORKER_TOOL_CALLS, RUN_RESULT, MILESTONE,
  "lead(design)": lead("design"),
  "lead(build)": lead("build"),
  reviewPrompt: reviewPrompt("/repo", tree, 0, 3, ""),
  fixPrompt: fixPrompt(1, 3, ""),
  ...Object.fromEntries(notes(join(root, "src")).map((note, i) => [`note ${String(i)}`, note])),
};

// Code spans, flags, markers and git's HEAD are syntax the CLI, core/reply.ts and git parse, not prose.
const prose = (text: string): string =>
  text.replace(/`[^`]*`/g, " ").replace(/<\/?[a-z]+>/g, " ").replace(/--[a-z-]+/g, " ").replace(/\bHEAD\b/g, " ");

// Banned for one concept, a word in its own right elsewhere: a run's task, an
// item's stage, a scheduled report, "them" for things rather than the user.
const OTHER_SENSE = new Set(["task", "stage", "report", "them"]);

describe("the prompt vocabulary", () => {
  it("reads a banned word for every row that names one", () => {
    expect(banned).toEqual(expect.arrayContaining(["delegate", "parent", "child", "spawn", ...OTHER_SENSE]));
  });

  it("keeps every banned word out of every prompt", () => {
    const found = Object.entries(prompts).flatMap(([name, text]) => banned
      .filter((word) => !OTHER_SENSE.has(word))
      .filter((word) => new RegExp(`\\b${word}\\b`, "i").test(prose(text)))
      .map((word) => `${name}: ${word}`));
    expect(found).toEqual([]);
  });
});
