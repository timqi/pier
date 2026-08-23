import { describe, expect, it } from "vitest";
import { fileMarker, lostMarker, safeName, splitInboundFiles } from "./inbound-file.js";

describe("safeName", () => {
  it("keeps an ordinary filename", () => {
    expect(safeName("notes.pdf", "application/pdf")).toBe("notes.pdf");
  });

  it("folds marker-breaking characters and strips any path", () => {
    expect(safeName("my shot (1).png", "image/png")).toBe("my-shot--1-.png");
    expect(safeName("../../etc/passwd", "text/plain")).toBe("passwd");
    expect(safeName("a\\b.txt", "text/plain")).toBe("a-b.txt");
  });

  it("derives a name from the mime type when there is none", () => {
    expect(safeName(undefined, "image/png")).toBe("file.png");
    expect(safeName("", "application/x-unknown")).toBe("file");
  });

  it("caps the length but keeps the extension", () => {
    const long = `${"a".repeat(100)}.jpeg`;
    const name = safeName(long, "image/jpeg");
    expect(name.length).toBe(64);
    expect(name.endsWith(".jpeg")).toBe(true);
  });
});

describe("fileMarker ↔ splitInboundFiles", () => {
  it("round-trips a plain path", () => {
    const { text, paths } = splitInboundFiles(`hello\n${fileMarker("/home/u/.pier/inbox/web/1-ab-shot.png")}`);
    expect(text).toBe("hello");
    expect(paths).toEqual(["/home/u/.pier/inbox/web/1-ab-shot.png"]);
  });

  it("round-trips a PIER_HOME with spaces and parentheses", () => {
    const path = "/srv/Pier State (prod)/inbox/telegram/1-ab-a.jpg";
    const marker = fileMarker(path);
    // The encoded link survives markdown: no raw space or paren inside `(…)`.
    expect(marker).toBe("[1-ab-a.jpg](file:///srv/Pier%20State%20%28prod%29/inbox/telegram/1-ab-a.jpg)");
    expect(splitInboundFiles(marker).paths).toEqual([path]);
  });

  it("takes only the trailing marker block — a mid-message link is text", () => {
    const raw = [
      "see [doc](file:///tmp/doc.txt) please",
      fileMarker("/tmp/inbox/web/1-ab-x.png"),
      fileMarker("/tmp/inbox/web/2-cd-y.pdf"),
    ].join("\n");
    const { text, paths } = splitInboundFiles(raw);
    expect(text).toBe("see [doc](file:///tmp/doc.txt) please");
    expect(paths).toEqual(["/tmp/inbox/web/1-ab-x.png", "/tmp/inbox/web/2-cd-y.pdf"]);
  });

  it("leaves a message without markers untouched", () => {
    expect(splitInboundFiles("plain\ntext")).toEqual({ text: "plain\ntext", paths: [] });
  });

  it("a lost-marker line is text, not an attachment", () => {
    const raw = `look\n${lostMarker("a.jpg", "download failed")}`;
    expect(splitInboundFiles(raw)).toEqual({ text: raw, paths: [] });
  });
});
