// The bounded body reader every platform download goes through: metadata is
// the platform's word, the read itself is the cap.

import { describe, expect, it } from "vitest";
import { readCapped } from "./inbox.js";

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe("readCapped", () => {
  it("joins the chunks under the cap", async () => {
    const bytes = await readCapped(streamOf([new TextEncoder().encode("ab"), new TextEncoder().encode("cd")]), 100);
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });

  it("refuses mid-stream past the cap, naming the reason", async () => {
    const big = streamOf([new Uint8Array(600), new Uint8Array(600)]);
    await expect(readCapped(big, 1000)).rejects.toThrow(/too large/);
  });

  it("treats a missing body as empty", async () => {
    expect((await readCapped(null, 10)).length).toBe(0);
  });
});
