// The two decisions in Settings → Agent that are not about drawing anything:
// what a write that did not land turns into, and in which order a tool the
// operator declared is taken away.

import { afterEach, describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../core/types.js";
import { removalStep, writeSettings } from "./config.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** One answer from PUT /api/settings, as the route sends it. */
const answering = (body: unknown, status = 200): void => {
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
};

/** The operator's own row, in whichever state the step under test needs. */
const declaredTool = (
  state: { enabled?: boolean; installed?: boolean; error?: string | null } = {},
): CatalogEntry => ({
  source: "binary",
  kind: "tool",
  name: "eza",
  summary: "",
  custom: true,
  enabled: state.enabled ?? true,
  binary: {
    spec: "github:eza-community/eza",
    installed: state.installed ?? true,
    version: "v0.23.0",
    path: "/p/bin/eza",
    error: state.error ?? null,
  },
});

describe("a settings write that did not land", () => {
  // The bug this test exists for: the switch stayed visually flipped, Add and
  // Remove stayed disabled, and nothing at all appeared on screen (§5b).
  it("is a failed outcome with no state to redraw from, not a rejection", async () => {
    globalThis.fetch = () => Promise.reject(new Error("Failed to fetch"));
    const { outcome, answer } = await writeSettings({ tool: { name: "rg", on: true } }, "Saved.");
    expect(outcome.state).toBe("failed");
    expect(outcome.text).toContain("Failed to fetch");
    expect(answer).toBeUndefined();
  });

  it("says what the server refused, when it is the server that refused", async () => {
    answering({ error: "this Pier manages no tool called rgg" }, 400);
    const { outcome, answer } = await writeSettings({ tool: { name: "rgg", on: true } }, "Saved.");
    expect(outcome).toEqual({ state: "failed", text: "this Pier manages no tool called rgg" });
    expect(answer).toBeUndefined();
  });

  it("does not claim saved when the answer cannot be read", async () => {
    globalThis.fetch = () => Promise.resolve(new Response("<html>proxy error</html>", { status: 200 }));
    const { outcome, answer } = await writeSettings({ tool: { name: "rg", on: true } }, "Saved.");
    expect(outcome.state).toBe("failed");
    expect(outcome.text).toContain("could not be read");
    expect(answer).toBeUndefined();
  });

  it("carries the state back, and what became of the install, when it did land", async () => {
    answering({ catalog: [], customTools: [], toolsTaskId: "t1", toolsSync: { state: "waiting" } });
    const waiting = await writeSettings({ tool: { name: "rg", on: true } }, "Saved.");
    expect(waiting.outcome).toEqual({
      state: "saved",
      text: "Saved — a sync is already running; this change goes in the run right after it.",
    });
    expect(waiting.answer?.toolsTaskId).toBe("t1");

    answering({ catalog: [], customTools: [], toolsTaskId: null, toolsSync: { state: "refused", reason: "no CLI to run" } });
    const refused = await writeSettings({ tool: { name: "rg", on: true } }, "Saved.");
    expect(refused.outcome).toEqual({ state: "failed", text: "Saved, but nothing will install it: no CLI to run" });
    // Refused is still stored: the page redraws from what came back.
    expect(refused.answer).toBeDefined();
  });
});

describe("removing a tool the operator declared", () => {
  const declared = [{ name: "eza", toml: `spec = "github:eza-community/eza"` }];

  // The bug this test exists for: the declaration was deleted in the same
  // write that switched the tool off, so a sync that then failed left an
  // installed binary on the PATH with no row and no line saying so.
  it("switches it off first and keeps the block ubix still needs", () => {
    const step = removalStep(declaredTool(), declared);
    expect(step.body).toEqual({ tool: { name: "eza", on: false } });
    expect(step.saved).toContain("Its block stays until ubix reports the binary gone");
  });

  it("keeps the block while the binary is still installed, or unknown", () => {
    expect(removalStep(declaredTool({ enabled: false }), declared).body).toEqual({ tool: { name: "eza", on: false } });
    // Switched off, and ubix could not be read: "gone" is not something to
    // assume from a failed read.
    expect(removalStep(declaredTool({ enabled: false, installed: false, error: "state.toml is locked" }), declared).body)
      .toEqual({ tool: { name: "eza", on: false } });
  });

  it("drops the declaration only once ubix reports the binary gone", () => {
    const step = removalStep(declaredTool({ enabled: false, installed: false }), declared);
    expect(step.body).toEqual({ customTools: [] });
    expect(step.saved).toBe("Removed eza.");
  });
});
