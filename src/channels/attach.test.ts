// Outbound attachments: the grammar an agent writes, and what a file that
// cannot be sent still owes the conversation. Hermetic — a temp dir, no
// network, no platform client.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type Attachment, MAX_ATTACH_BYTES, sendAttachments, splitAttachments } from "./attach.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-attach-"));
});

const write = (name: string, body = "hello"): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

/** Collect what an adapter would upload, and how it failed when it did not. */
const collect = async (paths: string[]): Promise<{ sent: Attachment[]; lost: string; logged: string[] }> => {
  const sent: Attachment[] = [];
  const logged: string[] = [];
  const lost = await sendAttachments(paths, (file) => {
    sent.push(file);
    return Promise.resolve();
  }, (m) => logged.push(m));
  return { sent, lost, logged };
};

describe("splitAttachments", () => {
  it("takes the link out and leaves its label in the sentence", () => {
    const { text, paths } = splitAttachments("Wrote [report.md](file:///tmp/report.md) for you.");
    expect(text).toBe("Wrote report.md for you.");
    expect(paths).toEqual(["/tmp/report.md"]);
  });

  it("falls back to the file's name, so an attachment-only turn is not empty", () => {
    // Otherwise the turn renders as "no reply" while a file arrives beside it.
    const { text, paths } = splitAttachments("[](file:///tmp/out.png)");
    expect(text).toBe("out.png");
    expect(paths).toEqual(["/tmp/out.png"]);
  });

  it("treats an image embed as the same request, sigil and all", () => {
    // `![alt](file://…)` left a stray `!` behind when only links were matched.
    const { text, paths } = splitAttachments("![the chart](file:///tmp/chart.png)");
    expect(text).toBe("the chart");
    expect(paths).toEqual(["/tmp/chart.png"]);
  });

  it("decodes a percent-encoded path and sends one copy of a repeated link", () => {
    const { paths } = splitAttachments(
      "[a](file:///tmp/my%20dir/a%281%29.txt) and again [a](file:///tmp/my%20dir/a%281%29.txt)",
    );
    expect(paths).toEqual(["/tmp/my dir/a(1).txt"]);
  });

  it("leaves http links and plain text alone", () => {
    const raw = "see [docs](https://example.com) and `file:///tmp/x`";
    expect(splitAttachments(raw)).toEqual({ text: raw, paths: [] });
  });
});

describe("sendAttachments", () => {
  it("reads the bytes and marks an image as one", async () => {
    const { sent, lost } = await collect([write("shot.PNG"), write("notes.txt")]);
    expect(sent.map((f) => [f.name, f.image])).toEqual([["shot.PNG", true], ["notes.txt", false]]);
    expect(new TextDecoder().decode(sent[0]!.bytes)).toBe("hello");
    expect(lost).toBe("");
  });

  it("says so in the chat when a file is missing, not only in the log", async () => {
    const { sent, lost, logged } = await collect([join(dir, "gone.txt")]);
    expect(sent).toEqual([]);
    expect(lost).toContain("attachment lost: gone.txt");
    expect(logged).toHaveLength(1);
  });

  it("refuses a file past the cap, and names it", async () => {
    const big = write("big.bin", "x".repeat(MAX_ATTACH_BYTES + 1));
    const { sent, lost } = await collect([big]);
    expect(sent).toEqual([]);
    expect(lost).toContain("too large");
  });

  it("reports an upload the platform refused", async () => {
    const logged: string[] = [];
    const lost = await sendAttachments(
      [write("a.txt")],
      () => Promise.reject(new Error("slack file upload: 413")),
      (m) => logged.push(m),
    );
    expect(lost).toContain("slack file upload: 413");
    expect(logged).toHaveLength(1);
  });

  it("sends the first five and says the rest were dropped", async () => {
    const paths = Array.from({ length: 7 }, (_, i) => write(`f${String(i)}.txt`));
    const { sent, lost } = await collect(paths);
    expect(sent).toHaveLength(5);
    expect(lost.split("\n")).toHaveLength(2);
    expect(lost).toContain("f6.txt");
  });
});
