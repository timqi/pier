import { describe, expect, it } from "vitest";
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
      name: "agent_end with error stopReason adds error event",
      input: {
        type: "agent_end",
        messages: [
          { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
        ],
      },
      expected: [
        { type: "turn-end", text: "" },
        { type: "error", message: "boom" },
        { type: "state", state: "idle" },
      ],
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
      { role: "user", text: "go" },
      {
        role: "assistant",
        text: "done",
        meta: { completedAt: 3000, durationMs: 2000, tokens: 0 },
        steps: [
          { kind: "thinking", text: "hmm" },
          { kind: "tool", toolName: "read", args: { path: "a.ts" }, output: "file", isError: false },
        ],
      },
    ]);
  });

  it("keeps activity from an aborted run as a text-less turn", () => {
    const turns = toChatTurns([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "", steps: [{ kind: "tool", toolName: "bash", args: {} }] },
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
