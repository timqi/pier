// What the retained session listing may and may not answer. The listing is a
// cache in front of a ~150ms disk scan, and the one answer it must never give
// from memory is "no such session" — a caller reads that as permission to
// start a replacement session (channels/conversations.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const listAll = vi.fn<() => Promise<{ id: string; path: string; cwd: string; created: Date }[]>>();
const created = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SessionManager: {
    listAll: () => listAll(),
    open: (path: string) => ({ path }),
    create: (cwd: string) => {
      created(cwd);
      return { path: `${cwd}/new`, getSessionDir: () => cwd };
    },
  },
  ModelRuntime: { create: async () => ({}) },
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  createAgentSession: async ({ sessionManager }: { sessionManager: { path: string } }) => ({
    session: {
      sessionId: sessionManager.path,
      isStreaming: false,
      messages: [],
      dispose() {},
    },
  }),
}));

const { PiAgentFactory } = await import("./pi.js");

const info = (id: string) => ({ id, path: `/s/${id}.jsonl`, cwd: "/tmp", created: new Date(0) });

let factory: InstanceType<typeof PiAgentFactory>;

beforeEach(() => {
  listAll.mockReset();
  created.mockReset();
  listAll.mockResolvedValue([info("s1")]);
  factory = new PiAgentFactory();
});

describe("the retained session listing", () => {
  it("scans once for a burst of surfaces asking at the same time", async () => {
    const [a, b, c] = await Promise.all([factory.list(), factory.list(), factory.list()]);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect([a, b, c].map((rows) => rows.length)).toEqual([1, 1, 1]);
    await factory.list();
    expect(listAll).toHaveBeenCalledTimes(1); // still inside the TTL
  });

  it("re-scans before calling a session unknown, so a live conversation is not replaced", async () => {
    listAll.mockResolvedValue([]);
    await factory.list(); // fills the listing with a disk state that predates s9
    listAll.mockResolvedValue([info("s9")]);
    await expect(factory.resume("s9")).resolves.toMatchObject({ id: "/s/s9.jsonl" });
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("pays that second scan only when the first one was a memory of an older disk", async () => {
    listAll.mockResolvedValue([]);
    await expect(factory.resume("s9")).rejects.toThrow("unknown session: s9");
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed scan as the answer", async () => {
    listAll.mockRejectedValueOnce(new Error("disk went away"));
    await expect(factory.list()).rejects.toThrow("disk went away");
    listAll.mockResolvedValue([info("s1")]);
    expect(await factory.list()).toHaveLength(1);
  });

  it("drops the listing when it opens a session of its own", async () => {
    await factory.list();
    await factory.create({ cwd: "/tmp/project" });
    await factory.list();
    expect(listAll).toHaveBeenCalledTimes(2);
    expect(created).toHaveBeenCalledWith("/tmp/project");
  });
});
