import { describe, expect, it } from "vitest";
import { MAX_STEP_OUTPUT } from "../core/types.js";
import { toChatTurns, toSessionEvents, turnMetaAt, type PiEvent, type PiMessage } from "./events.js";

describe("toSessionEvents", () => {
  const cases: { name: string; input: PiEvent; expected: unknown[] }[] = [
    {
      name: "agent_start → streaming + turn-start",
      input: { type: "agent_start" },
      expected: [
        { type: "state", state: "streaming" },
        { type: "turn-start" },
      ],
    },
    {
      name: "agent_end → turn-end with last assistant text + idle",
      input: {
        type: "agent_end",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
          { role: "toolResult" },
        ],
      },
      expected: [
        { type: "turn-end", text: "hello world" },
        { type: "state", state: "idle" },
      ],
    },
    {
      name: "agent_end with error stopReason ends the turn *as* the failure",
      input: {
        type: "agent_end",
        messages: [
          { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
        ],
      },
      expected: [
        // On the turn (what a task run settles on) and as the error event
        // (what a chat surface reports) — never as a turn that said nothing.
        { type: "turn-end", text: "", error: "boom" },
        { type: "error", message: "boom" },
        { type: "state", state: "idle" },
      ],
    },
    {
      name: "agent_end with an empty provider error still names the failure",
      input: {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "" }],
      },
      expected: [
        { type: "turn-end", text: "", error: "unknown agent error" },
        { type: "error", message: "unknown agent error" },
        { type: "state", state: "idle" },
      ],
    },
    {
      // Pi emits one agent_end per attempt. Reported, four 503s would be four
      // "no reply" turns and four errors for one turn that has not ended.
      name: "agent_end Pi is about to retry is not the end of anything",
      input: {
        type: "agent_end",
        willRetry: true,
        messages: [
          { role: "assistant", content: [], stopReason: "error", errorMessage: "503 overloaded" },
        ],
      },
      expected: [],
    },
    {
      name: "text_delta → text-delta",
      input: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abc" } },
      expected: [{ type: "text-delta", text: "abc" }],
    },
    {
      name: "thinking_delta → thinking-delta",
      input: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
      expected: [{ type: "thinking-delta", text: "hmm" }],
    },
    {
      name: "toolcall deltas are dropped",
      input: { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } },
      expected: [],
    },
    {
      name: "tool_execution_start → tool-start",
      input: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } },
      expected: [{ type: "tool-start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }],
    },
    {
      name: "tool_execution_end → tool-end with joined text output",
      input: {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "a.txt\n" }, { type: "image" }, { type: "text", text: "b.txt" }] },
      },
      expected: [{ type: "tool-end", toolCallId: "t1", isError: false, output: "a.txt\nb.txt" }],
    },
    {
      // The transcript renders nothing for a compaction (see toChatTurns
      // below), so this event is the only thing that ever says the context
      // shrank.
      name: "compaction_end → context-compacted with the tokens either side",
      input: {
        type: "compaction_end",
        result: { tokensBefore: 148_000, estimatedTokensAfter: 12_400 },
      },
      expected: [{ type: "context-compacted", before: 148_000, after: 12_400 }],
    },
    {
      name: "compaction_end without an estimate reports no shrink rather than guessing",
      input: { type: "compaction_end", result: { tokensBefore: 900 } },
      expected: [{ type: "context-compacted", before: 900, after: 900 }],
    },
    {
      name: "compaction_end with no result is a failure, not a silence",
      input: { type: "compaction_end", errorMessage: "Compaction failed: 429" },
      expected: [{ type: "error", message: "Compaction failed: 429" }],
    },
    {
      name: "queue_update → queue-state snapshot",
      input: { type: "queue_update", steering: ["a"], followUp: ["b", "c"] },
      expected: [{ type: "queue-state", steering: ["a"], followUp: ["b", "c"] }],
    },
    {
      name: "queue_update with empty queues",
      input: { type: "queue_update" },
      expected: [{ type: "queue-state", steering: [], followUp: [] }],
    },
    {
      name: "message_start with a user message → user-message (queued delivery)",
      input: { type: "message_start", message: { role: "user", content: "do it" } },
      expected: [{ type: "user-message", text: "do it" }],
    },
    {
      name: "message_start with a Pier custom message preserves provenance",
      input: {
        type: "message_start",
        message: {
          role: "custom",
          customType: "pier.system-input",
          content: "delegated work",
          details: { kind: "task-delegation", taskId: "t1", runId: "r1", sourceSessionId: "s1" },
        },
      },
      expected: [{
        type: "system-input",
        text: "delegated work",
        origin: { kind: "task-delegation", taskId: "t1", runId: "r1", sourceSessionId: "s1" },
      }],
    },
    {
      name: "message_start preserves task control message identity",
      input: {
        type: "message_start",
        message: {
          role: "custom",
          customType: "pier.system-input",
          content: "change direction",
          details: {
            kind: "task-message",
            taskId: "t1",
            runId: "r1",
            sourceSessionId: "s1",
            messageId: "m1",
            messageKind: "steer",
          },
        },
      },
      expected: [{
        type: "system-input",
        text: "change direction",
        origin: {
          kind: "task-message",
          taskId: "t1",
          runId: "r1",
          sourceSessionId: "s1",
          messageId: "m1",
          messageKind: "steer",
        },
      }],
    },
    {
      name: "message_start for non-user messages is dropped",
      input: { type: "message_start", message: { role: "assistant", content: "hi" } },
      expected: [],
    },
    {
      name: "unknown events are dropped",
      input: { type: "compaction_start" },
      expected: [],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(toSessionEvents(c.input)).toEqual(c.expected);
    });
  }
});

describe("toChatTurns", () => {
  it("attaches the thinking + tool activity that preceded each answer", () => {
    const turns = toChatTurns([
      { role: "user", content: "go", timestamp: 1000 },
      {
        role: "assistant",
        timestamp: 2000,
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file" }], isError: false },
      { role: "assistant", timestamp: 3000, content: [{ type: "text", text: "done" }] },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "go", at: 1000 },
      {
        role: "assistant",
        text: "done",
        meta: { completedAt: 3000, durationMs: 2000, tokens: 0 },
        steps: [
          { kind: "thinking", text: "hmm" },
          { kind: "tool", id: "t1", toolName: "read", args: { path: "a.ts" }, output: "file", isError: false, done: true },
        ],
      },
    ]);
  });

  // Kept as a test because it is the reason the `context-compacted` event
  // exists. Pi replaces the summarized entries with one `compactionSummary`
  // message (session-manager.ts, sessionEntryToContextMessages) — a role this
  // rebuild does not know, so the compaction leaves *no* trace in the
  // transcript a reload renders. If that ever changes, this expectation changes
  // with it and the event's reason for existing has to be re-argued.
  it("renders nothing for a compaction — which is why the event exists", () => {
    expect(toChatTurns([
      { role: "compactionSummary", content: "earlier work, summarized", timestamp: 1000 } as PiMessage,
      { role: "user", content: "carry on", timestamp: 2000 },
      { role: "assistant", content: "ok", timestamp: 3000 },
    ])).toEqual([
      { role: "user", text: "carry on", at: 2000 },
      { role: "assistant", text: "ok", meta: { completedAt: 3000, durationMs: 1000, tokens: 0 } },
    ]);
  });

  it("rebuilds persisted Pier system inputs with their origin", () => {
    const origin = { kind: "task-callback" as const, taskId: "t1", runId: "r1", sourceSessionId: "s2" };
    expect(toChatTurns([
      { role: "custom", customType: "pier.system-input", content: "result", details: origin, timestamp: 1000 },
      { role: "assistant", content: "handled", timestamp: 2000 },
    ])).toEqual([
      { role: "system", text: "result", origin, at: 1000 },
      { role: "assistant", text: "handled", meta: { completedAt: 2000, durationMs: 1000, tokens: 0 } },
    ]);
  });

  it("stamps user and system turns with when they arrived, and invents nothing", () => {
    // An assistant turn carries `meta.completedAt`; these two had no time at
    // all after a reload, so the hover chip had nothing to show.
    expect(toChatTurns([{ role: "user", content: "go", timestamp: 1000 }]))
      .toEqual([{ role: "user", text: "go", at: 1000 }]);
    expect(toChatTurns([{ role: "user", content: "go" }]))
      .toEqual([{ role: "user", text: "go" }]);
  });

  it("carries a system input's provenance back out of the transcript, checked", () => {
    const origin = { kind: "task-callback" as const, taskId: "t1", runId: "r1", sourceSessionId: "s2" };
    const source = { taskName: "review-web", model: { provider: "anthropic", id: "claude-opus-5" }, thinking: "high" };
    expect(toChatTurns([
      { role: "custom", customType: "pier.system-input", content: "done", details: { ...origin, source }, timestamp: 1 },
    ])).toEqual([{ role: "system", text: "done", origin: { ...origin, source }, at: 1 }]);
    // A source is metadata read off disk, so each half is kept only in the
    // shape it claims: a card drawing `undefined` in a chip reads as a bug in
    // the card, not as bad metadata.
    expect(toChatTurns([{
      role: "custom",
      customType: "pier.system-input",
      content: "done",
      details: { ...origin, source: { taskName: "review-web", model: "claude-opus-5", thinking: "very" } },
    }])).toEqual([{ role: "system", text: "done", origin: { ...origin, source: { taskName: "review-web" } } }]);
    // Nameless, or not an object at all: no card caption rather than an empty one.
    for (const bad of [{ model: { provider: "a", id: "b" } }, "review-web", null]) {
      expect(toChatTurns([{ role: "custom", customType: "pier.system-input", content: "done", details: { ...origin, source: bad } }]))
        .toEqual([{ role: "system", text: "done", origin }]);
    }
  });

  it("keeps activity from an aborted run as a text-less turn", () => {
    const turns = toChatTurns([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "", steps: [{ kind: "tool", id: "t1", toolName: "bash", args: {} }] },
    ]);
  });

  it("caps a tool result at what a surface shows", () => {
    // A session's tool output is most of its history payload; the bytes past
    // the cap were downloaded only to be sliced off at render time.
    const turns = toChatTurns([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "y".repeat(MAX_STEP_OUTPUT * 2) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(turns[1]?.steps?.[0]?.output).toBe("y".repeat(MAX_STEP_OUTPUT) + "…");
  });

  it("renders only the text of a legacy message with inline image blocks", () => {
    // Old transcripts carry base64 image blocks from before the inbox model;
    // they are simply not rendered — the text still is.
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(toChatTurns(messages)).toEqual([
      { role: "user", text: "look" },
      { role: "assistant", text: "ok" },
    ]);
  });
});

describe("turnMetaAt", () => {
  const msgs: PiMessage[] = [
    { role: "user", timestamp: 1000 },
    { role: "assistant", timestamp: 3000, usage: { totalTokens: 100 } },
    { role: "toolResult", timestamp: 4000 },
    { role: "user", timestamp: 10_000 },
    { role: "assistant", timestamp: 12_000, usage: { totalTokens: 250 } },
  ];

  it("computes duration from the preceding user message and context size", () => {
    // 250, not 350: totalTokens is already the whole request's context.
    expect(turnMetaAt(msgs, 4)).toEqual({ completedAt: 12_000, durationMs: 2000, tokens: 250 });
  });

  it("prefers a caller-supplied completion clock (live turn-end)", () => {
    expect(turnMetaAt(msgs, 4, 15_000)).toEqual({ completedAt: 15_000, durationMs: 5000, tokens: 250 });
  });

  it("reads the context size of the given turn, not later ones", () => {
    expect(turnMetaAt(msgs, 1)).toEqual({ completedAt: 3000, durationMs: 2000, tokens: 100 });
  });

  it("falls back to the last message that reported usage", () => {
    const withGap: PiMessage[] = [
      { role: "user", timestamp: 1000 },
      { role: "assistant", timestamp: 2000, usage: { totalTokens: 500 } },
      { role: "toolResult", timestamp: 2500 },
      { role: "assistant", timestamp: 3000 }, // aborted turn: no usage
    ];
    expect(turnMetaAt(withGap, 3)?.tokens).toBe(500);
  });

  it("returns undefined for non-assistant or untimestamped messages", () => {
    expect(turnMetaAt(msgs, 0)).toBeUndefined();
    expect(turnMetaAt([{ role: "assistant" }], 0)).toBeUndefined();
  });
});
