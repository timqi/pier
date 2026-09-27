// A prompt Pi refuses before its turn begins — no key for the model — must
// still leave the message and the reason in the transcript: a live error event
// alone is gone after a reload, or before the tab that sent it catches up.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { PiConfigStore } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { PiAgentFactory } from "./pi.js";

let factory: PiAgentFactory;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pier-no-key-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  // Pi reads provider keys straight off the environment (pi-ai's
  // env-api-keys), so the developer's own key would turn this into a live call.
  for (const name of Object.keys(process.env)) {
    if (/API_KEY|_TOKEN|^GOOGLE_|^GCLOUD_|^AWS_/.test(name)) vi.stubEnv(name, undefined);
  }
  const secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock();
  factory = new PiAgentFactory(() => "", [], new CredentialStore(openDb(":memory:"), secrets, dir), new PiConfigStore(dir));
});

afterAll(() => vi.unstubAllEnvs());

describe("a prompt sent with no key configured", () => {
  it("is refused, and the transcript still holds the message and why it went unanswered", async () => {
    // No credential anywhere: Pi's own default model has no key.
    const session = await factory.create({ cwd: mkdtempSync(join(tmpdir(), "pier-no-key-cwd-")) });

    await expect(session.prompt("hello")).rejects.toThrow(/No API key/);
    expect(await session.history()).toMatchObject([
      { role: "user", text: "hello" },
      { role: "assistant", text: "", error: expect.stringMatching(/No API key/) },
    ]);
    // What a reload reads: the file, not this runtime.
    expect(await factory.readHistory(session.id)).toMatchObject([
      { role: "user", text: "hello" },
      { role: "assistant", error: expect.stringMatching(/No API key/) },
    ]);
    await session.dispose();
  });
});
