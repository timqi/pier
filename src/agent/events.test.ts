import { describe, expect, it } from "vitest";
import { toSessionEvents, type PiEvent } from "./events.js";

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
      name: "queue_update is dropped (router emits queued)",
      input: { type: "queue_update" },
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
