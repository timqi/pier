// The system prompt a session reports is the one its requests carried: read
// back off the transcript and compared with the wire, on a real Pi session and
// Anthropic's provider, fetch stubbed so nothing leaves the process.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { PiConfigStore } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { PiAgentFactory } from "./pi.js";
import { replaySystemPrompt } from "./system-prompt.js";

/** The `system` text of every request, in order. */
const sent: string[] = [];
/** The `messages` of every request, as JSON. */
const wire: string[] = [];
let factory: PiAgentFactory;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pier-system-prompt-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  for (const name of Object.keys(process.env)) {
    if (/API_KEY|_TOKEN|^GOOGLE_|^GCLOUD_|^AWS_/.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { system?: { text: string }[]; messages?: unknown[] };
    wire.push(JSON.stringify(body.messages ?? []));
    sent.push((body.system ?? []).map((part) => part.text).join("\n\n"));
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stubbed" } }, { status: 400 });
  });
  const secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock();
  factory = new PiAgentFactory(() => "instance rules", [], new CredentialStore(openDb(":memory:"), secrets, dir), new PiConfigStore(dir));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a session's system prompt", () => {
  it("is the text its requests carried, by source, and follows a change made on resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-system-prompt-cwd-"));
    writeFileSync(join(cwd, "AGENTS.md"), "project rules v1");
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const session = await factory.create({ cwd, role: "worker", model });
    await session.prompt("hello").catch(() => {});
    const first = await factory.readSystemPrompt(session.id);
    expect(sent).toHaveLength(1);
    expect(first?.text).toBe(sent[0]);
    expect(first?.tokens).toBe(Math.ceil(sent[0]!.length / 4));
    expect(first?.blocks.map((b) => [b.label, b.path])).toEqual([
      ["Pier baseline", undefined],
      ["AGENTS.md", join(cwd, "AGENTS.md")],
      ["Pier instructions", "<pier>/AGENTS.md"],
      ["Role prompt", "<pier>/worker.md"],
      ["Working directory", undefined],
    ]);
    expect(first?.blocks[1]?.text).toBe("project rules v1");
    expect(first?.blocks[2]?.text).toBe("instance rules");
    expect(first?.blocks.at(-1)?.text).toBe(cwd);
    await session.dispose();

    // A resumed session carries today's files, patched onto the prompt it had.
    writeFileSync(join(cwd, "AGENTS.md"), "project rules v2");
    const resumed = await factory.resume(session.id);
    expect((await factory.readSystemPrompt(session.id))?.text).toBe(sent[0]);
    await resumed.prompt("again").catch(() => {});
    const second = await factory.readSystemPrompt(session.id);
    expect(sent).toHaveLength(2);
    expect(second?.text).toBe(sent[1]);
    expect(second?.blocks[1]?.text).toBe("project rules v2");
    await resumed.dispose();
  });

  it("is unknown for a session that does not exist", async () => {
    expect(await factory.readSystemPrompt("no-such-session")).toBeUndefined();
  });

  it("splits a codemode worker's baseline, its tool-call guidance included, from the user's SYSTEM.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pier-system-prompt-codemode-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "SYSTEM.md"), "user system");
    const codemode = new PiAgentFactory(() => "", [], undefined, undefined, undefined, () => ({ skillsOff: [], workerCodemode: true }));
    const session = await codemode.create({ cwd: dir, role: "worker", model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    await session.prompt("hello").catch(() => {});
    const blocks = (await codemode.readSystemPrompt(session.id))?.blocks;
    expect(sent.at(-1)).toContain("# Tool calls\n- A step with two or more");
    expect(blocks?.[0]).toMatchObject({ label: "Pier baseline" });
    expect(blocks?.[0]?.text).toMatch(/# Tool calls[^]*strictly serial steps[^]*\n\n# Working style[^]*without running it\.$/);
    expect(blocks?.[1]).toEqual({ label: "SYSTEM.md", text: "user system" });
    await session.dispose();
  });

  it("reaches the first request of a session a system input opens \u2014 every task run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-system-prompt-run-"));
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const session = await factory.create({ cwd, role: "worker", model });
    const before = sent.length;
    // Pi builds the prompt in `prompt()` only; the custom message a run opens
    // with would otherwise reach the model with no cwd, files or skills.
    await session.systemInput("do the task", { kind: "task-delegation", taskId: "t", runId: "r", sourceSessionId: null }, "prompt").catch(() => {});
    expect(sent).toHaveLength(before + 1);
    expect(sent[before]).toContain(`<cwd>\n${cwd}\n</cwd>`);
    expect(sent[before]).toContain("<pier>/worker.md");
    expect((await factory.readSystemPrompt(session.id))?.text).toBe(sent[before]);
    // The timeline row the run's input renders as is still the custom message.
    expect((await session.history())[0]).toMatchObject({ role: "system", text: "do the task", origin: { kind: "task-delegation", runId: "r" } });
    await session.dispose();
  });
});

describe("a chat command's answer", () => {
  it("is shown in the transcript and never reaches the model; a seed does", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-chat-command-"));
    const session = await factory.create({ cwd, model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    await session.systemInput("seed digest", { kind: "session-seed", reason: "first", previousSessionId: null }, "append");
    await session.systemInput("Waiting on you\n- storage", { kind: "chat-command", command: "status" }, "append");
    await session.systemInput("nothing running", { kind: "chat-command", command: "stop" }, "append");
    await session.prompt("hello").catch(() => {});
    const request = wire.at(-1)!;
    expect(request).toContain("seed digest");
    expect(request).toContain("hello");
    expect(request).not.toContain("Waiting on you");
    expect(request).not.toContain("nothing running");
    // The last turn is the stubbed provider's refusal.
    expect((await session.history()).map((t) => t.text).slice(0, 4)).toEqual(["seed digest", "Waiting on you\n- storage", "nothing running", "hello"]);
    await session.dispose();
  });
});

describe("replaySystemPrompt", () => {
  it("is null before any request carried one", () => {
    expect(replaySystemPrompt([{ role: "user", content: "hi" }], ["base"])).toBeNull();
  });

  it("drops a removed section, and names a preamble that is not Pier's", () => {
    const prompt = replaySystemPrompt([
      { role: "system", content: "", sections: { preamble: "custom", skills: "<skills>\nlist\n</skills>", cwd: "<cwd>\n/w\n</cwd>" } },
      { role: "system", content: "", sections: { skills: null } },
    ], ["base"]);
    expect(prompt).toEqual({
      text: "custom\n\n<cwd>\n/w\n</cwd>",
      tokens: 6,
      blocks: [{ label: "Preamble", text: "custom" }, { label: "Working directory", text: "/w" }],
    });
  });

  it("splits Pier's baseline from the user's SYSTEM.md", () => {
    const prompt = replaySystemPrompt([{ role: "system", content: "", sections: { preamble: "base\n\nmine" } }], ["base"]);
    expect(prompt?.blocks).toEqual([{ label: "Pier baseline", text: "base" }, { label: "SYSTEM.md", text: "mine" }]);
  });
});
