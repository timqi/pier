// The one thing the Pi seam must refuse: work handed to a session that is
// already closed. Pi answers such a call by running a turn nobody records, so
// every delivery path upstream would count a lost message as delivered.

import { describe, expect, it } from "vitest";
import { PiSession } from "./pi.js";

/** Only what PiSession touches on these paths. */
function fakePi() {
  const calls: string[] = [];
  return {
    calls,
    pi: {
      sessionId: "s1",
      isStreaming: false,
      messages: [],
      prompt: () => {
        calls.push("prompt");
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
