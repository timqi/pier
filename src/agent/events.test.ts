import { describe, expect, it } from "vitest";
import { toSessionEvents, turnMetaAt, type PiEvent, type PiMessage } from "./events.js";

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

describe("turnMetaAt", () => {
  const msgs: PiMessage[] = [
    { role: "user", timestamp: 1000 },
    { role: "assistant", timestamp: 3000, usage: { totalTokens: 100 } },
    { role: "toolResult", timestamp: 4000 },
    { role: "user", timestamp: 10_000 },
    { role: "assistant", timestamp: 12_000, usage: { totalTokens: 250 } },
  ];

  it("computes duration from the preceding user message and cumulative tokens", () => {
    expect(turnMetaAt(msgs, 4)).toEqual({ completedAt: 12_000, durationMs: 2000, tokens: 350 });
  });

  it("prefers a caller-supplied completion clock (live turn-end)", () => {
    expect(turnMetaAt(msgs, 4, 15_000)).toEqual({ completedAt: 15_000, durationMs: 5000, tokens: 350 });
  });

  it("only counts tokens up to the given turn", () => {
    expect(turnMetaAt(msgs, 1)).toEqual({ completedAt: 3000, durationMs: 2000, tokens: 100 });
  });

  it("returns undefined for non-assistant or untimestamped messages", () => {
    expect(turnMetaAt(msgs, 0)).toBeUndefined();
    expect(turnMetaAt([{ role: "assistant" }], 0)).toBeUndefined();
  });
});
