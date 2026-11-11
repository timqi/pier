// The system prompt a session reports is the one its requests carried: read
// back off the transcript and compared with the wire, on a real Pi session and
// Anthropic's provider, fetch stubbed so nothing leaves the process.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { PiConfigStore } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { PiAgentFactory, pierSystemPrompt } from "./pi.js";
import { DISPATCHER, lead, ROLE_GUARD, surfacePrompt, WORKER } from "./roles.js";
import { replaySystemPrompt } from "./system-prompt.js";

const instance = { publicUrl: "", skillsDir: "/opt/pier/skills" };

/** The `system` text of every request, in order. */
const sent: string[] = [];
/** The `messages` of every request, as JSON. */
const wire: string[] = [];
let factory: PiAgentFactory;
/** What `roleOf` hands a reopened session, as main.ts reads a head's chain. */
const reopened = new Map<string, { contextFiles: string[] }>();

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
  factory = new PiAgentFactory((role) => surfacePrompt(instance, role), [], new CredentialStore(openDb(":memory:"), secrets, dir), new PiConfigStore(dir),
    undefined, undefined, undefined, undefined, (id) => reopened.get(id) ?? {});
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
      ["Role · worker", undefined],
      ["AGENTS.md", join(cwd, "AGENTS.md")],
      ["Working directory", undefined],
    ]);
    expect(first?.blocks[0]?.text).toBe(pierSystemPrompt(undefined, "worker", surfacePrompt(instance, "worker")));
    expect(first?.blocks[1]?.text).toBe(WORKER);
    expect(first?.blocks[2]?.text).toBe("project rules v1");
    expect(first?.blocks.at(-1)?.text).toBe(cwd);
    expect(first?.text).not.toContain("<pier>/");
    await session.dispose();

    // A resumed session carries today's files, patched onto the prompt it had.
    writeFileSync(join(cwd, "AGENTS.md"), "project rules v2");
    const resumed = await factory.resume(session.id);
    expect((await factory.readSystemPrompt(session.id))?.text).toBe(sent[0]);
    await resumed.prompt("again").catch(() => {});
    const second = await factory.readSystemPrompt(session.id);
    expect(sent).toHaveLength(2);
    expect(second?.text).toBe(sent[1]);
    expect(second?.blocks.find((b) => b.label === "AGENTS.md")?.text).toBe("project rules v2");
    await resumed.dispose();
  });

  // Two chains' heads in one home: the home's AGENTS.md, then the session's own charter and no other's.
  it("carries a launch's context files after the cwd's own, each session only its own, reopened too", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-system-prompt-home-"));
    writeFileSync(join(home, "AGENTS.md"), "home rules");
    const files = (text: string) => [...text.matchAll(/<project_instructions path="([^"]*)">\n(.*)\n<\/project_instructions>/g)].map((m) => m.slice(1));
    for (const chain of ["alpha", "beta"]) {
      const charter = join(home, "chains", chain, "AGENTS.md");
      mkdirSync(dirname(charter), { recursive: true });
      writeFileSync(charter, `charter of ${chain}`);
      const session = await factory.create({ cwd: home, model: { provider: "anthropic", id: "claude-sonnet-4-5" }, contextFiles: [charter] });
      reopened.set(session.id, { contextFiles: [charter] });
      await session.prompt("hello").catch(() => {});
      expect(files(sent.at(-1)!)).toEqual([[join(home, "AGENTS.md"), "home rules"], [charter, `charter of ${chain}`]]);
      await session.dispose();

      writeFileSync(charter, `charter of ${chain}, edited`);
      const resumed = await factory.resume(session.id);
      await resumed.prompt("again").catch(() => {});
      expect(files(sent.at(-1)!)).toEqual([[join(home, "AGENTS.md"), "home rules"], [charter, `charter of ${chain}, edited`]]);
      await resumed.dispose();
    }
  });

  it("is unknown for a session that does not exist", async () => {
    expect(await factory.readSystemPrompt("no-such-session")).toBeUndefined();
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
    expect(sent[before]).toContain("# You are a worker");
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

describe("a session holding only Pier's input", () => {
  it("is on disk, so closing it loses nothing \u2014 a seeded head evicted before anyone spoke", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-seed-only-"));
    const session = await factory.create({ cwd, model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    await session.systemInput("seed digest", { kind: "session-seed", reason: "idle", previousSessionId: null }, "append");
    await session.systemInput("nothing running", { kind: "chat-command", command: "stop" }, "append");
    await session.dispose();
    const resumed = await factory.resume(session.id);
    expect((await resumed.history()).map((t) => t.text)).toEqual(["seed digest", "nothing running"]);
    // Pi's own first write must still land once someone speaks.
    await resumed.prompt("hello").catch(() => {});
    await resumed.dispose();
    expect((await factory.readHistory(session.id))?.map((t) => t.text).slice(0, 3)).toEqual(["seed digest", "nothing running", "hello"]);
  });
});

describe("replaySystemPrompt", () => {
  it("is null before any request carried one", () => {
    expect(replaySystemPrompt([{ role: "user", content: "hi" }])).toBeNull();
  });

  it("drops a removed section, and names a preamble that is not Pier's", () => {
    const prompt = replaySystemPrompt([
      { role: "system", content: "", sections: { preamble: "custom", skills: "<skills>\nlist\n</skills>", cwd: "<cwd>\n/w\n</cwd>" } },
      { role: "system", content: "", sections: { skills: null } },
    ]);
    expect(prompt).toEqual({
      text: "custom\n\n<cwd>\n/w\n</cwd>",
      tokens: 6,
      blocks: [{ label: "Preamble", text: "custom" }, { label: "Working directory", text: "/w" }],
    });
  });

  const replayed = (preamble: string, projectContext?: string) =>
    replaySystemPrompt([{ role: "system", content: "", sections: { preamble, ...(projectContext ? { project_context: projectContext } : {}) } }])?.blocks;

  it("cuts the preamble by structure, for every role, with and without SYSTEM.md", () => {
    const roles = [
      [undefined, "", undefined],
      ["worker", WORKER, "Role · worker"],
      ["lead", lead("design"), "Role · lead · design"],
      ["lead", lead("build"), "Role · lead · build"],
      [undefined, DISPATCHER, "Role · dispatcher"],
    ] as const;
    for (const [role, contract, label] of roles) {
      const baseline = pierSystemPrompt(undefined, role, surfacePrompt(instance, role));
      // A SYSTEM.md may carry headings of its own, `# You are …` ones too: with no role it stays the user's whole.
      for (const user of [undefined, "# Mine\nlocal rules", "# You are terse\nlocal rules", "# You are the main session's helper\nlocal rules", "# You are a worker bee\nlocal rules", "# You are a feature lead's scribe\nlocal rules"]) {
        expect(replayed(pierSystemPrompt(user, role, surfacePrompt(instance, role), contract))).toEqual([
          { label: "Pier baseline", text: baseline },
          ...(user ? [{ label: "SYSTEM.md", text: user }] : []),
          ...(label ? [{ label, text: contract }] : []),
        ]);
      }
    }
  });

  it("names an unrecognised role Role, and a baseline without the surface's end Preamble", () => {
    const baseline = pierSystemPrompt(undefined, undefined, surfacePrompt(instance));
    expect(replayed(`${baseline}\n\n# You are a reviewer\n\nrules. ${ROLE_GUARD}`)?.map((b) => b.label)).toEqual(["Pier baseline", "Role"]);
    expect(replayed(`base\n\n${WORKER}`)).toEqual([{ label: "Preamble", text: `base\n\n${WORKER}` }]);
    // A contract is known by its title too, whatever its guard read when the transcript was written.
    expect(replayed(`${baseline}\n\n${WORKER.replace(ROLE_GUARD, "an older sentence.")}`)?.map((b) => b.label)).toEqual(["Pier baseline", "Role · worker"]);
  });

  it("labels an older transcript's Pier files by what they were", () => {
    const file = (path: string, text: string) => `<project_instructions path="${path}">\n${text}\n</project_instructions>`;
    const context = ["/repo/AGENTS.md", "<pier>/AGENTS.md", "<pier>/dispatcher.md", "<pier>/lead.md", "<pier>/worker.md", "<pier>/other.md"]
      .map((path) => file(path, "x")).join("\n\n");
    expect(replayed("base", `<project_context>\n# Project Context\n\n${context}\n</project_context>`)?.map((b) => b.label))
      .toEqual(["Preamble", "AGENTS.md", "Pier surface", "Role · dispatcher", "Role · lead", "Role · worker", "Role"]);
  });
});
