import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOX_DIR, saveInbound } from "./inbox.js";
import { splitInboundFiles, fileMarker } from "./inbound-file.js";

describe("saveInbound", () => {
  it("writes under the channel's inbox dir and round-trips through the marker", async () => {
    const path = await saveInbound("telegram", "a.txt", "text/plain", new TextEncoder().encode("hello"));
    expect(path.startsWith(join(INBOX_DIR, "telegram") + "/")).toBe(true);
    expect(path.endsWith("-a.txt")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello");
    // The saved path survives its own marker: what the agent sees resolves.
    expect(splitInboundFiles(fileMarker(path)).paths).toEqual([path]);
  });

  it("is owner-only: uploads are private content on a shared machine", async () => {
    const path = await saveInbound("web", "p.txt", "text/plain", new Uint8Array([1]));
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(INBOX_DIR, "web")).mode & 0o077).toBe(0);
  });

  it("never collides, even for identical names in the same millisecond", async () => {
    const [a, b] = await Promise.all([
      saveInbound("web", "x.png", "image/png", new Uint8Array([1])),
      saveInbound("web", "x.png", "image/png", new Uint8Array([2])),
    ]);
    expect(a).not.toBe(b);
  });
});
