// The system prompt a session reports is the one its requests carried: read
// back off the transcript and compared with the wire, on a real Pi session and
// Anthropic's provider, fetch stubbed so nothing leaves the process.

import { mkdtempSync, writeFileSync } from "node:fs";
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
let factory: PiAgentFactory;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pier-system-prompt-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  for (const name of Object.keys(process.env)) {
    if (/API_KEY|_TOKEN|^GOOGLE_|^GCLOUD_|^AWS_/.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { system?: { text: string }[] };
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
});

describe("replaySystemPrompt", () => {
  it("is null before any request carried one", () => {
    expect(replaySystemPrompt([{ role: "user", content: "hi" }], "base")).toBeNull();
  });

  it("drops a removed section, and names a preamble that is not Pier's", () => {
    const prompt = replaySystemPrompt([
      { role: "system", content: "", sections: { preamble: "custom", skills: "<skills>\nlist\n</skills>", cwd: "<cwd>\n/w\n</cwd>" } },
      { role: "system", content: "", sections: { skills: null } },
    ], "base");
    expect(prompt).toEqual({
      text: "custom\n\n<cwd>\n/w\n</cwd>",
      tokens: 6,
      blocks: [{ label: "Preamble", text: "custom" }, { label: "Working directory", text: "/w" }],
    });
  });

  it("splits Pier's baseline from the user's SYSTEM.md", () => {
    const prompt = replaySystemPrompt([{ role: "system", content: "", sections: { preamble: "base\n\nmine" } }], "base");
    expect(prompt?.blocks).toEqual([{ label: "Pier baseline", text: "base" }, { label: "SYSTEM.md", text: "mine" }]);
  });
});
