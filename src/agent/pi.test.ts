// The one thing the Pi seam must refuse: work handed to a session that is
// already closed. Pi answers such a call by running a turn nobody records, so
// every delivery path upstream would count a lost message as delivered.
// Plus the one rule that decides which copy of a bundled extension runs, and
// the runtime state that must remain private to one session.

import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionEventPayload } from "../core/types.js";
import type { PiEvent, PiMessage } from "./events.js";

type Stream = (model: unknown, context: unknown, options?: unknown) => unknown;
type Runtime = { providers: Set<string>; registerProvider(name: string): void; streamSimple: Stream };
const runtimes: Runtime[] = [];
const streamed: unknown[] = [];
/** The Pi sessions the factory opened, for the settings it applies to them. */
const opened: { agent: { followUpMode: string }; overrides: unknown[] }[] = [];
type Skill = { name: string; filePath: string };
type Files = { agentsFiles: { path: string; content: string }[] };
type LoaderOptions = { skillsOverride: (base: { skills: Skill[] }) => { skills: Skill[] }; agentsFilesOverride: (f: Files) => Files };
/** What each open handed Pi's resource loader. */
const loaders: LoaderOptions[] = [];

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SessionManager: {
    create: (cwd: string) => ({ path: `${cwd}/new`, getSessionDir: () => cwd }),
    open: (path: string) => ({ path }),
  },
  ModelRuntime: {
    create: async () => {
      const runtime: Runtime = {
        providers: new Set(),
        registerProvider(name) { this.providers.add(name); },
        streamSimple: (_model, _context, options) => {
          streamed.push(options);
          return {};
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  },
  DefaultResourceLoader: class {
    constructor(options: unknown) { loaders.push(options as LoaderOptions); }
    async reload(): Promise<void> {}
  },
  createAgentSession: async ({ cwd, modelRuntime }: { cwd: string; modelRuntime: Runtime }) => {
    // Pi extensions register providers onto the runtime handed to this session.
    modelRuntime.registerProvider(cwd);
    const session = {
      sessionId: cwd,
      isStreaming: false,
      messages: [],
      // Pi's default: one queued follow-up per turn boundary.
      agent: { followUpMode: "one-at-a-time" },
      model: { provider: "p", id: "m", contextWindow: 400_000 },
      overrides: [] as unknown[],
      settingsManager: {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
        applyOverrides: (o: unknown) => session.overrides.push(o),
      },
      dispose() {},
    };
    opened.push(session);
    return { session };
  },
}));

const { PiAgentFactory, PiSession, titleFromAnswer } = await import("./pi.js");

/** Only what PiSession touches on these paths. */
function fakePi() {
  const calls: string[] = [];
  /** Pi's own subscribers, so a test can be the Pi session emitting an event. */
  const listeners = new Set<(event: PiEvent) => void>();
  /** What each prompt was queued as, kept apart from `calls` so the ordering
   *  assertions elsewhere stay about ordering. */
  const promptOptions: unknown[] = [];
  /** Held open, so a test can be *inside* a compaction when it dispatches. */
  let release: ((err?: Error) => void) | undefined;
  return {
    calls,
    promptOptions,
    emit: (event: PiEvent) => {
      for (const fn of listeners) fn(event);
    },
    finishCompaction: (err?: Error) => {
      release?.(err);
      release = undefined;
    },
    pi: {
      sessionId: "s1",
      isStreaming: false,
      messages: [] as PiMessage[],
      subscribe(fn: (event: PiEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
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
      getSteeringMessages: () => [] as string[],
      getFollowUpMessages: () => [] as string[],
      clearQueue: () => {
        calls.push("clearQueue");
        return { steering: [], followUp: [] };
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

describe("session model runtimes", () => {
  it("keeps extension providers and cache retention private to one session", async () => {
    const factory = new PiAgentFactory();
    const a = await factory.create({ cwd: "/tmp/a" });
    const b = await factory.create({ cwd: "/tmp/b" });

    expect(runtimes).toHaveLength(2);
    expect([...runtimes[0]!.providers]).toEqual(["/tmp/a"]);
    expect([...runtimes[1]!.providers]).toEqual(["/tmp/b"]);
    a.setCacheRetention("short");
    runtimes[0]!.streamSimple({}, {});
    runtimes[1]!.streamSimple({}, {}, { cacheRetention: "none" });
    expect(streamed).toEqual([
      { cacheRetention: "short" },
      { cacheRetention: "none" },
    ]);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it("takes Pi's whole follow-up queue at each turn boundary, not one message", async () => {
    const factory = new PiAgentFactory();
    const session = await factory.create({ cwd: "/tmp/queue" });
    // Pi's default drains one queued follow-up per boundary, so N progress
    // reports cost N model turns and a message behind them waits them all out.
    expect(opened.at(-1)?.agent.followUpMode).toBe("all");
    await session.dispose();
  });
});

describe("the pier package's skills off-list", () => {
  it("drops only Pier's own skill of that name, at session open", async () => {
    const factory = new PiAgentFactory(undefined, ["/pier/skills"], undefined, undefined, undefined,
      () => ({ skillsOff: ["pier-help"] }));
    await (await factory.create({ cwd: "/tmp/off" })).dispose();
    const skills = [
      { name: "pier-help", filePath: "/pier/skills/pier-help/SKILL.md" },
      { name: "pier-help", filePath: "/home/u/.pier/pi/skills/pier-help/SKILL.md" },
      { name: "pier-tasks", filePath: "/pier/skills/pier-tasks/SKILL.md" },
    ];
    expect(loaders.at(-1)!.skillsOverride({ skills }).skills.map((s) => s.filePath)).toEqual([
      "/home/u/.pier/pi/skills/pier-help/SKILL.md",
      "/pier/skills/pier-tasks/SKILL.md",
    ]);
  });

  it("opens a worker without pier-tasks and a lead with its contract, created or reopened", async () => {
    const factory = new PiAgentFactory(() => "", ["/pier/skills"], undefined, undefined, undefined, undefined, undefined, {
      scan: async () => ["worker-1", "lead-1"].map((id) => ({ id, path: join(mkdtempSync(join(tmpdir(), "pier-role-")), "f.jsonl"), cwd: "/tmp/wt", created: 1, modified: 2 })),
    }, (id) => (id === "worker-1" ? "worker" : id === "lead-1" ? "lead" : undefined));
    const skills = [
      { name: "pier-tasks", filePath: "/pier/skills/pier-tasks/SKILL.md" },
      { name: "pier-help", filePath: "/pier/skills/pier-help/SKILL.md" },
    ];
    const opened = async (session: Promise<{ dispose(): Promise<void> }>) => {
      await (await session).dispose();
      const loader = loaders.at(-1)!;
      return [...loader.skillsOverride({ skills }).skills.map((s) => s.name), ...loader.agentsFilesOverride({ agentsFiles: [] }).agentsFiles.map((f) => f.path)];
    };
    expect(await opened(factory.create({ cwd: "/tmp/wt", role: "worker" }))).toEqual(["pier-help"]);
    expect(await opened(factory.resume("worker-1"))).toEqual(["pier-help"]);
    expect(await opened(factory.create({ cwd: "/tmp/wt", role: "lead" }))).toEqual(["pier-tasks", "pier-help", "<pier>/lead.md"]);
    expect(await opened(factory.resume("lead-1"))).toEqual(["pier-tasks", "pier-help", "<pier>/lead.md"]);
    expect(await opened(factory.create({ cwd: "/tmp/wt" }))).toEqual(["pier-tasks", "pier-help"]);
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

describe("a system input handed to a streaming session", () => {
  const origin = {
    kind: "task-message", taskId: "t", runId: "r", sourceSessionId: "parent",
    messageId: "m1", messageKind: "follow_up",
  } as const;

  it("is reported as in flight — Pi's own queues cannot see it", async () => {
    const { fake, session: s } = session();
    fake.pi.isStreaming = true;
    await s.systemInput("guidance", origin, "followUp");
    // Pi parks a custom message on the agent, so both of these stay empty and
    // the transcript has nothing either: a sender asking them would re-send
    // the same guidance every sweep until it gave up on a delivered message.
    expect(await s.pendingQueue()).toEqual({ steering: [], followUp: [] });
    expect(await s.pendingSystemInputs()).toEqual([origin]);
  });

  it("stops being in flight once the turn that would drain it is over", async () => {
    const { fake, session: s } = session();
    fake.pi.isStreaming = true;
    await s.systemInput("guidance", origin, "followUp");
    fake.pi.isStreaming = false;
    // Idle means drained, aborted or cleared — never "still on its way": a
    // sender told otherwise waits on it forever (§5).
    expect(await s.pendingSystemInputs()).toEqual([]);
  });

  it("is dropped from the queue the composer recalls, though it is nobody's draft", async () => {
    const { fake, session: s } = session();
    fake.pi.isStreaming = true;
    await s.systemInput("guidance", origin, "followUp");
    await s.clearQueue();
    expect(await s.pendingSystemInputs()).toEqual([]);
    expect(fake.calls).toEqual(["sendCustomMessage", "clearQueue"]);
  });

  it("is not in flight when the session took it as a turn", async () => {
    const { session: s } = session();
    await s.systemInput("guidance", origin, "followUp");
    // Idle: Pi appended it and started a turn, so the transcript is the answer.
    expect(await s.pendingSystemInputs()).toEqual([]);
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

describe("a turn the provider never answered", () => {
  const outage = '503 {"error":{"message":"Upstream service overloaded"},"type":"error"}';
  /** What Pi records for an attempt that never reached the model: an assistant
   *  message with no content at all, and the reason on the side. */
  const stopped = (): PiMessage => ({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: outage,
    timestamp: 1,
  });

  it("crosses the seam as a failure carrying the provider's words", () => {
    const fake = fakePi();
    const s = new PiSession(fake.pi as never);
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    const final = stopped();
    fake.pi.messages.push(final);
    fake.emit({ type: "agent_end", messages: [final] });
    // An empty turn-end alone is what every surface reads as "said nothing";
    // the error is on the turn *and* delivered, so neither can miss it.
    expect(seen).toMatchObject([
      { type: "turn-end", text: "", error: outage },
      { type: "error", message: outage },
    ]);
  });

  it("ends exactly once after Pi's retries are exhausted", () => {
    const fake = fakePi();
    const s = new PiSession(fake.pi as never);
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    const final = stopped();
    fake.pi.messages.push(final);
    // Pi retried this one four times in a row on a real outage. Each attempt
    // ends an agent run of its own; only the last of them ended the turn.
    fake.emit({ type: "agent_end", willRetry: true, messages: [final] });
    expect(seen).toEqual([]);
    fake.emit({ type: "agent_end", willRetry: false, messages: [final] });
    fake.emit({ type: "agent_settled" });
    expect(seen).toMatchObject([
      { type: "turn-end", text: "", error: outage },
      { type: "error", message: outage },
      { type: "state", state: "idle" },
    ]);
  });

  it("settles as aborted when retry backoff is cancelled", () => {
    const fake = fakePi();
    const s = new PiSession(fake.pi as never);
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    const attempt = stopped();
    fake.pi.messages.push(attempt);
    fake.emit({ type: "agent_end", willRetry: true, messages: [attempt] });
    fake.emit({ type: "auto_retry_end" });
    fake.emit({ type: "agent_settled" });
    expect(seen).toMatchObject([
      { type: "turn-end", text: "" },
      { type: "state", state: "idle" },
    ]);
  });
});

describe("the moment the seam calls a session idle", () => {
  it("already reads idle inside the subscriber the idle event wakes", () => {
    const fake = fakePi();
    // Pi's real order: `_isAgentRunActive` stays true across the last
    // `agent_end` — auto-compaction and queued continuations run past it — and
    // is cleared one statement before `agent_settled` is emitted.
    fake.pi.isStreaming = true;
    const s = new PiSession(fake.pi as never);
    const seen: SessionEventPayload[] = [];
    const readBack: string[] = [];
    s.subscribe((event) => {
      seen.push(event);
      if (event.type === "state" && event.state === "idle") readBack.push(s.state);
    });
    const answer: PiMessage = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 };
    fake.pi.messages.push(answer);
    fake.emit({ type: "agent_end", messages: [answer] });
    // An idle here would be the seam contradicting itself, which is what left
    // tasks/agent.ts re-arming for an event it had already been handed.
    expect(seen).toMatchObject([{ type: "turn-end", text: "done" }]);
    expect(s.state).toBe("streaming");

    fake.pi.isStreaming = false;
    fake.emit({ type: "agent_settled" });
    expect(seen.at(-1)).toEqual({ type: "state", state: "idle" });
    // The inverted assertion is the contract: whoever the idle wakes may act
    // on `state` without racing Pi.
    expect(readBack).toEqual(["idle"]);
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

describe("a session naming itself after its first exchange", () => {
  const exchange = (fake: ReturnType<typeof fakePi>, users = 1): void => {
    for (let i = 0; i < users; i++) {
      fake.pi.messages.push({ role: "user", content: `[operator<web> 10:12] fix the parser (${i})`, timestamp: 1 });
      fake.pi.messages.push({ role: "assistant", content: [{ type: "text", text: "Done — parser.ts" }], timestamp: 2 });
    }
    fake.emit({ type: "agent_end", messages: fake.pi.messages });
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks the title model once, appends the answer and announces the rename", async () => {
    const suggest = vi.fn(async () => "Parser fix");
    const wrote = vi.fn();
    const fake = fakePi();
    const s = new PiSession(fake.pi as never, () => [], wrote, { value: "long" }, () => suggest);
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    s.subscribe(() => {}); // a second consumer (a task run) sees the same turn-end
    exchange(fake);
    await settle();
    expect(suggest).toHaveBeenCalledExactlyOnceWith("[operator<web> 10:12] fix the parser (0)", "Done — parser.ts");
    expect(fake.calls).toContain("appendSessionInfo:Parser fix");
    expect(wrote).toHaveBeenCalledOnce();
    expect(seen).toContainEqual({ type: "renamed", title: "Parser fix" });
  });

  it("reports a failed request as an error on the session, and keeps the prompt title", async () => {
    const fake = fakePi();
    const s = new PiSession(fake.pi as never, () => [], () => {}, { value: "long" }, () => async () => {
      throw new Error("401 invalid key");
    });
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    exchange(fake);
    await settle();
    expect(fake.calls).not.toContainEqual(expect.stringMatching(/^appendSessionInfo/));
    expect(seen).toContainEqual({ type: "error", message: expect.stringContaining("401 invalid key") });
  });

  it("leaves alone a session that has a name, has history, or whose operator picked no model", async () => {
    const suggest = vi.fn(async () => "never");
    // Named (a task's, or a rename during the turn).
    const named = fakePi();
    named.pi.sessionManager.appendSessionInfo("digest");
    named.calls.length = 0;
    new PiSession(named.pi as never, () => [], () => {}, { value: "long" }, () => suggest).subscribe(() => {});
    exchange(named);
    // Resumed with more than one exchange behind it.
    const old = fakePi();
    new PiSession(old.pi as never, () => [], () => {}, { value: "long" }, () => suggest).subscribe(() => {});
    exchange(old, 2);
    // Off.
    const off = fakePi();
    new PiSession(off.pi as never).subscribe(() => {});
    exchange(off);
    await settle();
    expect(suggest).not.toHaveBeenCalled();
    expect([...named.calls, ...old.calls, ...off.calls]).not.toContainEqual(expect.stringMatching(/^appendSessionInfo/));
  });

  it("does not overwrite a name a person gave while the model was thinking", async () => {
    let answer!: (title: string) => void;
    const fake = fakePi();
    const s = new PiSession(fake.pi as never, () => [], () => {}, { value: "long" }, () => () => new Promise((r) => (answer = r)));
    const seen: SessionEventPayload[] = [];
    s.subscribe((event) => seen.push(event));
    exchange(fake);
    await s.rename("my own name");
    answer("model's name");
    await settle();
    expect(fake.pi.sessionManager.getSessionName()).toBe("my own name");
    expect(seen).not.toContainEqual(expect.objectContaining({ type: "renamed" }));
  });
});

describe("a directory reached through a symlink", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "pier-real-")));
  const link = join(mkdtempSync(join(tmpdir(), "pier-link-")), "proj");
  symlinkSync(real, link);

  it("is created under its real path, so one directory is one project", async () => {
    const factory = new PiAgentFactory();
    const session = await factory.create({ cwd: link });
    // The mocked SessionManager/createAgentSession name the session after the
    // cwd they were handed.
    expect(session.id).toBe(real);
    await session.dispose();
  });

  /** A factory whose disk is one session in `cwd`. */
  const listing = (cwd: string) =>
    new PiAgentFactory(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      scan: async () => [{ id: "s", path: `${cwd}/f.jsonl`, cwd, created: 1, modified: 2 }],
    });

  it("is listed under its real path, however an older session recorded it", async () => {
    expect((await listing(link).list())[0]?.cwd).toBe(real);
  });

  // A worktree that was merged and removed: the rail must still read it as a
  // branch of the repository beside it, which only holds if the part of the
  // path that does exist is spelled the way that repository's own session is.
  it("resolves as much of a deleted directory's path as still exists", async () => {
    const gone = join(link, "pier.merged-branch");
    expect((await listing(gone).list())[0]?.cwd).toBe(join(real, "pier.merged-branch"));
  });
});

describe("titleFromAnswer", () => {
  it("takes one clean line out of whatever the model said", () => {
    expect(titleFromAnswer('"Parser fix."\nsecond line')).toBe("Parser fix");
    expect(titleFromAnswer("「解析器修复」。")).toBe("解析器修复");
    expect(titleFromAnswer("  \n")).toBe("");
    expect(titleFromAnswer("x".repeat(100))).toHaveLength(80);
  });
});

describe("the continuous conversation's seam", () => {
  const injected = async (cwd: string, continuous: boolean): Promise<string[]> => {
    const factory = new PiAgentFactory(() => "pier notes", [], undefined, undefined, undefined,
      () => ({ skillsOff: [], continuous }));
    await (await factory.create({ cwd })).dispose();
    return loaders.at(-1)!.agentsFilesOverride({ agentsFiles: [{ path: "/repo/AGENTS.md", content: "repo" }] }).agentsFiles.map((f) => f.path);
  };

  it("injects the dispatcher contract only into a session in the home, and only while the switch is on", async () => {
    const home = join(process.env.PIER_HOME!, "home");
    expect(await injected(home, true)).toEqual(["/repo/AGENTS.md", "<pier>/AGENTS.md", "<pier>/dispatcher.md"]);
    expect(await injected(home, false)).toEqual(["/repo/AGENTS.md", "<pier>/AGENTS.md"]);
    expect(await injected("/tmp/elsewhere", true)).toEqual(["/repo/AGENTS.md", "<pier>/AGENTS.md"]);
  });

  it("compacts a main session at 100K and a run's child at 150K while the switch is on, and no other session", async () => {
    const home = join(process.env.PIER_HOME!, "home");
    const path = () => join(mkdtempSync(join(tmpdir(), "pier-cap-")), "f.jsonl");
    const factory = (continuous: boolean) => new PiAgentFactory(() => "", [], undefined, undefined, undefined,
      () => ({ skillsOff: [], continuous }), undefined, {
        scan: async () => [["member", home], ["worker-1", "/tmp/wt"], ["user-1", "/tmp/wt"]]
          .map(([id, cwd]) => ({ id: id!, path: path(), cwd: cwd!, created: 1, modified: 2 })),
      }, (id) => (id === "worker-1" ? "worker" : undefined));
    const reserves = async (open: Promise<{ dispose(): Promise<void> }>) => {
      await (await open).dispose();
      return opened.at(-1)!.overrides;
    };
    const main = [{ compaction: { reserveTokens: 300_000 } }];
    const child = [{ compaction: { reserveTokens: 250_000 } }];
    const on = factory(true);
    expect(await reserves(on.create({ cwd: home }))).toEqual(main);
    expect(await reserves(on.create({ cwd: "/tmp/wt", role: "lead" }))).toEqual(child);
    expect(await reserves(on.resume("worker-1"))).toEqual(child);
    // Decided by what the session is, not by who opens it: a run reusing a
    // chain member leaves it at main's cap, and a user's session uncapped.
    expect(await reserves(on.resume("member"))).toEqual(main);
    expect(await reserves(on.resume("user-1"))).toEqual([]);
    expect(await reserves(on.create({ cwd: "/tmp/wt" }))).toEqual([]);
    const off = factory(false);
    expect(await reserves(off.create({ cwd: home }))).toEqual([]);
    expect(await reserves(off.create({ cwd: "/tmp/wt", role: "worker" }))).toEqual([]);
  });

  /** A session whose model and settings manager are what the cap reads and writes. */
  function capped(window: number, cap?: number, instanceReserve = 16_384) {
    const fake = fakePi();
    const overrides: unknown[] = [];
    const models: Record<string, { provider: string; id: string; contextWindow: number }> = {
      big: { provider: "p", id: "big", contextWindow: 1_000_000 },
      small: { provider: "p", id: "small", contextWindow: 64_000 },
    };
    Object.assign(fake.pi, {
      model: { provider: "p", id: "m", contextWindow: window },
      settingsManager: {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: instanceReserve, keepRecentTokens: 20_000 }),
        applyOverrides: (o: unknown) => overrides.push(o),
      },
      modelRuntime: { getModel: (_p: string, id: string) => models[id] },
      setModel(m: { contextWindow: number }) { (fake.pi as unknown as { model: unknown }).model = m; },
    });
    return { s: new PiSession(fake.pi as never, () => [], () => {}, { value: "long" }, () => undefined, cap), overrides };
  }

  it("turns a cap into a reserve for the model's window, and recomputes it on a model switch", async () => {
    const { s, overrides } = capped(400_000, 100_000);
    expect(overrides).toEqual([{ compaction: { reserveTokens: 300_000 } }]);
    await s.setModel({ provider: "p", id: "big" });
    // A window no larger than the cap keeps the instance's reserve, never compacting later than it would.
    await s.setModel({ provider: "p", id: "small" });
    expect(overrides.slice(1)).toEqual([
      { compaction: { reserveTokens: 900_000 } },
      { compaction: { reserveTokens: 16_384 } },
    ]);
  });

  it("leaves a session without a cap on the instance's setting", async () => {
    const { s, overrides } = capped(400_000);
    await s.setModel({ provider: "p", id: "big" });
    expect(overrides).toEqual([]);
  });

  it("appends a seed without starting a turn", async () => {
    const { fake, session: s } = session();
    const sent: unknown[] = [];
    fake.pi.sendCustomMessage = (...args: unknown[]) => {
      sent.push(args[1]);
      return Promise.resolve();
    };
    await s.systemInput("seed", { kind: "session-seed", reason: "first", previousSessionId: null }, "append");
    expect(sent).toEqual([{ triggerTurn: false, deliverAs: undefined }]);
    expect(await s.pendingSystemInputs()).toEqual([]);
  });

  it("reads the branch, so a compaction that kept no user turn still shows the last one", async () => {
    const { fake, session: s } = session();
    const reply = { role: "assistant", content: [{ type: "text", text: "a long answer" }], timestamp: 3 };
    Object.assign(fake.pi.sessionManager, {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "before the compaction", timestamp: 2 } },
        { type: "compaction", summary: "summary", tokensBefore: 9, timestamp: "2026-01-01T00:00:00Z" },
        { type: "message", message: reply },
      ],
    });
    // The model's context after the compaction: not one user turn left in it.
    fake.pi.messages = [reply] as PiMessage[];
    expect((await s.history()).filter((t) => t.role === "user")).toEqual([{ role: "user", text: "before the compaction", at: 2 }]);
  });
});
