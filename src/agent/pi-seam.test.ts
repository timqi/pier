// What Pier leaves to Pi at the seam, run against the real SDK: a system
// input's turn gets its system prompt from Pi alone, and a resumed session's
// tools come from its transcript. A mocked Pi cannot notice either moving.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, SystemInputOrigin } from "../core/types.js";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { PiConfigStore } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { PiAgentFactory } from "./pi.js";

let factory: PiAgentFactory;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pier-seam-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  // No key anywhere, so every turn fails at the request: nothing goes live.
  for (const name of Object.keys(process.env)) {
    if (/API_KEY|_TOKEN|^GOOGLE_|^GCLOUD_|^AWS_/.test(name)) vi.stubEnv(name, undefined);
  }
  const secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock();
  factory = new PiAgentFactory(() => "", [], new CredentialStore(openDb(":memory:"), secrets, dir), new PiConfigStore(dir),
    undefined, undefined, undefined, undefined, () => ({ role: "worker" }));
});

afterAll(() => vi.unstubAllEnvs());

const callback = (runId: string): SystemInputOrigin => ({ kind: "task-callback", taskId: "t", runId, sourceSessionId: null });

type Entry = { type: string; customType?: string; content?: unknown; message?: { role: string; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } };

async function transcript(session: AgentSession, cwd: string): Promise<{ path: string; entries: Entry[] }> {
  const info = (await SessionManager.list(cwd)).find((s) => s.id === session.id);
  if (!info) throw new Error(`no transcript for ${session.id}`);
  return { path: info.path, entries: SessionManager.open(info.path).getBranch() as Entry[] };
}

const systemMessages = (entries: Entry[]) => entries.flatMap((e) => (e.type === "message" && e.message?.role === "system" ? [e.message] : []));
const inputs = (entries: Entry[]) => entries.flatMap((e) => (e.customType === "pier.system-input" ? [e.content] : []));

describe("a system input against Pi", () => {
  it("starts its turn with Pier's system prompt loaded once, the input verbatim, and one sent meanwhile joins that turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-seam-cwd-"));
    const session = await factory.create({ cwd, role: "worker" });
    const states: string[] = [];
    session.subscribe((e) => { if (e.type === "state") states.push(e.state); });
    const first = session.systemInput("first", callback("r1"), "prompt");
    // Busy from the call on: the second is queued into this run, not refused.
    expect(session.state).toBe("streaming");
    await session.systemInput("second", callback("r2"), "followUp");
    expect(await session.pendingSystemInputs()).toEqual([callback("r2")]);
    await first;

    // One run: the session goes idle once, after the second input's own turn.
    expect(states.filter((s) => s === "idle")).toEqual(["idle"]);
    const { entries } = await transcript(session, cwd);
    const system = systemMessages(entries);
    expect(system).toHaveLength(1);
    expect(system[0]?.sections?.preamble).toContain("# Tool calls\n- Every tool result stays in your context");
    expect(system[0]?.toolsAdded?.map((t) => t.name)).toEqual(["read", "bash", "edit", "write"]);
    expect(inputs(entries)).toEqual(["first", "second"]);
    expect(entries.filter((e) => e.message?.role === "assistant")).toHaveLength(2);
    await session.dispose();
  });

  it("resumes a worker whose transcript enabled codemode with today's tools, codemode dropped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-seam-cwd-"));
    const session = await factory.create({ cwd, role: "worker" });
    await session.systemInput("before", callback("r1"), "prompt");
    await session.dispose();
    const { path } = await transcript(session, cwd);
    SessionManager.open(path).appendMessage({
      role: "system", content: "", timestamp: Date.now(),
      toolsAdded: [{ name: "codemode", description: "run a script", parameters: { type: "object", properties: {} } }],
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const resumed = await factory.resume(session.id);
    await resumed.systemInput("after", callback("r2"), "prompt");
    const patch = systemMessages((await transcript(resumed, cwd)).entries).at(-1);
    // The prompt is unchanged; only the tool Pier no longer registers leaves.
    expect(patch).toMatchObject({ toolsRemoved: [{ name: "codemode" }] });
    expect(patch?.toolsAdded).toBeUndefined();
    expect(patch?.sections).toBeUndefined();
    await resumed.dispose();
  });
});
