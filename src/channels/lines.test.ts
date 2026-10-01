import { describe, expect, it } from "vitest";
import { noteBody } from "./lines.js";

describe("noteBody", () => {
  it("quotes a chat command's answer whole, where a callback is digested", () => {
    const text = Array.from({ length: 8 }, (_, i) => `- item ${String(i)}`).join("\n");
    const body = noteBody({ text, origin: { kind: "chat-command", command: "status" } }, "*");
    expect(body).toBe(`*/status*\n${text.split("\n").map((l) => `> ${l}`).join("\n")}`);
    const digested = noteBody({ text, origin: { kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null } }, "*");
    expect(digested).toContain("… +4 more lines");
  });

  it("drops legacy run ids without rewriting modern status titles", () => {
    const text = "- a (running) · run x0d7dyb1… running now";
    expect(noteBody({ text, origin: { kind: "chat-command", command: "status" } }, "*")).toBe("*/status*\n> - a (running) · running now");
    expect(noteBody({ text, origin: { kind: "error" } }, "*")).toContain("run x0d7dyb1…");
    expect(noteBody({ text, origin: { kind: "chat-command", command: "status", statusSnapshot: { version: 1, items: [] } } }, "*")).toBe(`*/status*\n> ${text}`);
  });
});
