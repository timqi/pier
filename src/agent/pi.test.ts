// The one thing the Pi seam must refuse: work handed to a session that is
// already closed. Pi answers such a call by running a turn nobody records, so
// every delivery path upstream would count a lost message as delivered.
// Plus the one rule that decides which copy of a bundled extension runs.

import { describe, expect, it, vi } from "vitest";
import { PiSession, standDownShadowed, standDownUndocumented } from "./pi.js";

/** Only what PiSession touches on these paths. */
function fakePi() {
  const calls: string[] = [];
  /** What each prompt was queued as, kept apart from `calls` so the ordering
   *  assertions elsewhere stay about ordering. */
  const promptOptions: unknown[] = [];
  /** Held open, so a test can be *inside* a compaction when it dispatches. */
  let release: ((err?: Error) => void) | undefined;
  return {
    calls,
    promptOptions,
    finishCompaction: (err?: Error) => {
      release?.(err);
      release = undefined;
    },
    pi: {
      sessionId: "s1",
      isStreaming: false,
      messages: [] as { role: string; content: unknown }[],
      // Pi's manager, as far as a rename is concerned: one append, and the
      // latest name is what it reads back.
      sessionManager: {
        name: undefined as string | undefined,
        appendSessionInfo(name: string) {
          calls.push(`appendSessionInfo:${name}`);
          this.name = name.trim() || undefined;
        },
        getSessionName() {
          return this.name;
        },
      },
      compact: () => {
        calls.push("compact");
        return new Promise<void>((resolve, reject) => {
          release = (err) => (err ? reject(err) : resolve());
        });
      },
      prompt: (_text: string, options?: unknown) => {
        calls.push("prompt");
        promptOptions.push(options);
        return Promise.resolve();
      },
      steer: () => {
        calls.push("steer");
        return Promise.resolve();
      },
      followUp: () => {
        calls.push("followUp");
        return Promise.resolve();
      },
      sendCustomMessage: () => {
        calls.push("sendCustomMessage");
        return Promise.resolve();
      },
      dispose: () => calls.push("dispose"),
    },
  };
}

function session() {
  const fake = fakePi();
  // The seam is typed against the SDK's session; a full double would be noise.
  return { fake, session: new PiSession(fake.pi as never) };
}

/** Only the two fields the rule reads. */
const ext = (path: string, ...tools: string[]) =>
  ({ path, tools: new Map(tools.map((t) => [t, {}])) }) as never;
const shadow = (...extensions: unknown[]): string[] =>
  standDownShadowed({ extensions, errors: [], runtime: {} } as never)
    .extensions.map((e) => e.path);

describe("a bundled extension shadowed by a copy on disk", () => {
  it("stands down, so one name never means two tools", () => {
    expect(shadow(
      ext("/home/u/.pier/pi/extensions/web", "web_search", "web_fetch"),
      ext("<inline:web>", "web_search", "web_fetch"),
    )).toEqual(["/home/u/.pier/pi/extensions/web"]);
  });

  it("stands down on a single shared tool, whatever the extension is called", () => {
    expect(shadow(ext("/x/mine.ts", "web_search"), ext("<inline:web>", "web_fetch", "web_search")))
      .toEqual(["/x/mine.ts"]);
  });

  it("leaves the bundled one alone when nothing on disk claims its tools", () => {
    expect(shadow(
      ext("/x/quiet.ts", "be_quiet"),
      ext("<inline:web>", "web_search"),
      ext("<inline:pier-bash-timeout>"),
    )).toEqual(["/x/quiet.ts", "<inline:web>", "<inline:pier-bash-timeout>"]);
  });
});

describe("a bundled skill whose tool this session was not given", () => {
  const tool = (name: string, skill?: string, available?: boolean) =>
    ({ name, skill, available: available === undefined ? undefined : () => available }) as never;
  const skills = [{ name: "pier-slack" }, { name: "pier-tasks" }];

  it("stands down with it, so no prompt advertises a route that is switched off", () => {
    expect(standDownUndocumented([tool("slack", "pier-slack", false)], skills))
      .toEqual([{ name: "pier-tasks" }]);
  });

  it("stays when the tool is there, or claims no skill at all", () => {
    expect(standDownUndocumented([tool("slack", "pier-slack", true)], skills)).toEqual(skills);
    expect(standDownUndocumented([tool("slack", "pier-slack")], skills)).toEqual(skills);
    // An unavailable tool documented by nothing takes nothing with it.
    expect(standDownUndocumented([tool("task", undefined, false)], skills)).toEqual(skills);
  });
});

describe("a disposed session", () => {
  it("refuses every way of putting work into it, instead of dropping it", async () => {
    const { fake, session: s } = session();
    await s.dispose();
    await expect(s.prompt("hi")).rejects.toThrow("closed");
    await expect(s.steer("hi")).rejects.toThrow("closed");
    await expect(s.followUp("hi")).rejects.toThrow("closed");
    await expect(
      s.systemInput("result", { kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null }, "followUp"),
    ).rejects.toThrow("closed");
    // A rejection is what makes a callback retry; a resolved promise would
    // have marked the run delivered and lost it.
    await expect(s.history()).rejects.toThrow("closed");
    expect(fake.calls).toEqual(["dispose"]);
  });

  it("refuses to compact, which Pi would run against a dead listener", async () => {
    const { fake, session: s } = session();
    await s.dispose();
    await expect(s.compact()).rejects.toThrow("closed");
    expect(fake.calls).toEqual(["dispose"]);
  });

  it("still takes work before that", async () => {
    const { fake, session: s } = session();
    await s.prompt("hi");
    await s.systemInput(
      "x",
      { kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null },
      "followUp",
    );
    expect(fake.calls).toEqual(["prompt", "sendCustomMessage"]);
  });
});

describe("a prompt that races a turn", () => {
  it("is queued rather than thrown away", async () => {
    const { fake, session: s } = session();
    await s.prompt("hi");
    // Bare, Pi refuses a prompt that arrives while a turn is running and the
    // message is gone. The core decided "prompt" against a state it read one
    // step earlier, so the queue is where a turn that started since must put
    // it — the same place core/queue.ts sends an auto message mid-turn.
    expect(fake.promptOptions).toEqual([{ streamingBehavior: "followUp" }]);
  });

  it("queues the ones the compaction gate released together, not just the first", async () => {
    const { fake, session: s } = session();
    const compaction = s.compact();
    const first = s.prompt("one");
    const second = s.prompt("two");
    fake.finishCompaction();
    await compaction;
    await Promise.all([first, second]);
    // Both were decided against an idle session and both reach Pi; without the
    // option the second is the one that disappears.
    expect(fake.promptOptions).toEqual([
      { streamingBehavior: "followUp" },
      { streamingBehavior: "followUp" },
    ]);
  });
});

describe("a session that is compacting", () => {
  const origin = { kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null } as const;

  it("runs one compaction at a time — the second is refused, not queued", async () => {
    const { fake, session: s } = session();
    const first = s.compact();
    // Two POSTs both pass the route's idle check; Pi keeps no lock of its own,
    // so the second would abort the first's work and summarize a transcript
    // being replaced under it.
    await expect(s.compact()).rejects.toThrow("already compacting");
    expect(fake.calls).toEqual(["compact"]);
    fake.finishCompaction();
    await first;
    // The gate releases: a later compaction is a normal one.
    const again = s.compact();
    fake.finishCompaction();
    await again;
    expect(fake.calls).toEqual(["compact", "compact"]);
  });

  it("holds a prompt and a system input until the summary lands, losing neither", async () => {
    const { fake, session: s } = session();
    const compaction = s.compact();
    const dispatched = s.prompt("after the check, before the summary");
    const callback = s.systemInput("a run finished", origin, "followUp");
    // Nothing has started a turn: that is the race the gate exists for.
    await Promise.resolve();
    expect(fake.calls).toEqual(["compact"]);
    fake.finishCompaction();
    await compaction;
    await Promise.all([dispatched, callback]);
    // Both arrive, in order, after the compaction — not dropped, and not run
    // against a context being rewritten.
    expect(fake.calls).toEqual(["compact", "prompt", "sendCustomMessage"]);
  });

  it("lets everything through again when the compaction *failed*", async () => {
    const { fake, session: s } = session();
    const compaction = s.compact();
    const dispatched = s.prompt("hi");
    fake.finishCompaction(new Error("nothing to compact"));
    // The failure is the caller's to report; what must not happen is a session
    // left gated behind a compaction that will never finish.
    await expect(compaction).rejects.toThrow("nothing to compact");
    await dispatched;
    expect(fake.calls).toEqual(["compact", "prompt"]);
    // And the gate is open for the next one, rather than stuck on the failure.
    const retry = s.compact();
    fake.finishCompaction();
    await retry;
  });
});

describe("naming a session", () => {
  it("appends the name to the transcript and answers nothing", async () => {
    const { fake, session: s } = session();
    await expect(s.rename("parser work")).resolves.toBeUndefined();
    expect(fake.calls).toContain("appendSessionInfo:parser work");
  });

  // The factory keeps a listing for a few seconds, and a rename lands inside
  // that window: without this, every surface re-reads the old title and keeps
  // it until something unrelated moves the list again.
  it("tells the factory its retained listing is out of date", async () => {
    const wrote = vi.fn();
    const fake = fakePi();
    const s = new PiSession(fake.pi as never, () => [], wrote);
    await s.rename("");
    expect(wrote).toHaveBeenCalledOnce();
  });
});
