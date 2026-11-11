// What a chain's head is sent, wired as main.ts wires it: the real chain and
// router on a real Pi session and Anthropic's provider, fetch stubbed so nothing
// leaves the process. The instance layer is the one place core/ and agent/ meet.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PiConfigStore } from "./agent/config.js";
import { CredentialStore } from "./agent/credentials.js";
import { PiAgentFactory } from "./agent/pi.js";
import { DISPATCHER, surfacePrompt } from "./agent/roles.js";
import { MainChain } from "./core/chain.js";
import { Chains } from "./core/chains.js";
import { EventHub } from "./core/hub.js";
import { Router } from "./core/router.js";
import { openDb } from "./db.js";
import { pierPath } from "./paths.js";
import { Secrets } from "./secrets.js";

const home = pierPath("home");
const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
/** Every request, in order: its `system` text, its `messages` and its first message as JSON. */
const sent: { system: string; messages: string; first: string }[] = [];
const db = openDb(":memory:");
const chains = new Chains(db, () => 0);
let factory: PiAgentFactory;
let router: Router;
let chain: MainChain;

/** A process's router and chain over the same database and transcripts. */
function start(): void {
  router = new Router(new EventHub(), (key) => factory.resume(key.conversationId));
  chain = new MainChain(db, {
    factory, router, home, chains,
    ledger: () => [],
    launcher: () => null,
    status: () => ({ text: "Nothing open.", seed: "Nothing open.", sessions: {}, snapshot: { version: 1, items: [] } }),
    close: (_chainId, query) => query,
    changed: () => {},
    defaults: async () => ({ defaultModel: model, defaultThinkingLevel: null }),
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pier-head-prompt-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  // Pi reads user-level skills under $HOME.
  vi.stubEnv("HOME", dir);
  for (const name of Object.keys(process.env)) {
    if (/API_KEY|_TOKEN|^GOOGLE_|^GCLOUD_|^AWS_/.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { system?: { text: string }[]; messages?: unknown[] };
    sent.push({
      system: (body.system ?? []).map((part) => part.text).join("\n\n"),
      messages: JSON.stringify(body.messages ?? []),
      first: JSON.stringify(body.messages?.[0] ?? null),
    });
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stubbed" } }, { status: 400 });
  });
  const secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock();
  factory = new PiAgentFactory((role) => surfacePrompt({ publicUrl: "", skillsDir: "/opt/pier/skills" }, role), [],
    new CredentialStore(openDb(":memory:"), secrets, dir), new PiConfigStore(dir),
    undefined, undefined, undefined, undefined, (id) => ({ contextFiles: chain.contextFiles(id) }));
  start();
});

afterAll(async () => {
  for (const { session } of router.attachedSessions()) await session.dispose();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** One message to `chainId`, answered with the request it made. */
async function say(chainId: string): Promise<{ system: string; messages: string; first: string }> {
  const before = sent.length;
  await chain.send({ senderId: "web", sender: { id: "web", name: "operator" }, text: "hello", mode: "auto" }, chainId);
  await vi.waitFor(() => { expect(sent.length).toBeGreaterThan(before); });
  return sent[before]!;
}

describe("a chain's head", () => {
  it("is sent its role, the home's AGENTS.md, then its own chain's charter, and its memory as the first message — reopened too", async () => {
    const write = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(home, "AGENTS.md"), "home rules");
    write(join(home, "MEMORY.md"), "global memory");
    const ids = [chains.first().id, chains.create("Beta").id];
    const charter = (id: string) => join(home, "chains", id, "AGENTS.md");
    for (const id of ids) {
      write(charter(id), `charter of ${id}`);
      write(join(home, "chains", id, "MEMORY.md"), `memory of ${id}`);
    }
    const file = (path: string, text: string) => `<project_instructions path="${path}">\n${text}\n</project_instructions>`;
    const title = DISPATCHER.split("\n", 1)[0]!;
    /** Where the role, the home's file and the chain's charter sit in a request's system text. */
    const placed = (system: string, id: string, text: string) =>
      [title, file(join(home, "AGENTS.md"), "home rules"), file(charter(id), text)].map((part) => system.indexOf(part));

    for (const [n, id] of ids.entries()) {
      const other = ids[1 - n]!;
      const { system, messages, first } = await say(id);
      const order = placed(system, id, `charter of ${id}`);
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(system).not.toContain(`charter of ${other}`);
      // Memory is the seed's, the first message: never the system prompt's, as the charter is never the seed's.
      expect(system).not.toContain("memory of");
      expect(system).not.toContain("global memory");
      expect(messages).not.toContain("charter of");
      expect(messages).not.toContain(`memory of ${other}`);
      const memory = ["global memory", `memory of ${id}`].map((part) => first.indexOf(part));
      expect(memory[0]).toBeGreaterThanOrEqual(0);
      expect(memory[1]).toBeGreaterThan(memory[0]!);
    }

    // A restart: the heads are on disk, and each is reopened with the charter its chain has by then.
    const heads = ids.map((id) => chain.members(id).map((m) => m.sessionId));
    for (const { session } of router.attachedSessions()) await session.dispose();
    start();
    for (const [n, id] of ids.entries()) {
      write(charter(id), `charter of ${id}, edited`);
      const { system } = await say(id);
      const order = placed(system, id, `charter of ${id}, edited`);
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(system).not.toContain(`charter of ${ids[1 - n]!}`);
      // Resumed, not rotated: a new head would be launched with the charter and prove nothing of the reopen;
      // a lost one replaces its member, so the id is what tells.
      expect(chain.members(id).map((m) => m.sessionId)).toEqual(heads[n]);
    }
  });
});
