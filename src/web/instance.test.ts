import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Secrets, type VtClient } from "../secrets.js";
import { untilUnlockSettled } from "./instance.js";

/** A vt-mode master.key, and a vt whose `read` answers only when the test says:
 *  the window between the listener opening and the human's approval. */
async function vtBoot(): Promise<{ secrets: Secrets; approve: () => void; refuse: () => void }> {
  const path = join(mkdtempSync(join(tmpdir(), "pier-instance-")), "master.key");
  const records = new Map<string, string>();
  const vt: VtClient = {
    create: async (plaintext) => {
      const record = `vt://0${String(records.size)}`;
      records.set(record, plaintext);
      return record;
    },
    read: async (record) => records.get(record) ?? "",
    doctor: async () => "",
  };
  const setup = new Secrets(path, vt);
  await setup.unlock();
  await setup.rotateKek("vt");
  let approve = (): void => undefined;
  let refuse = (): void => undefined;
  const gated = new Secrets(path, {
    ...vt,
    read: (record) => new Promise((resolve, reject) => {
      approve = () => resolve(records.get(record) ?? "");
      refuse = () => reject(new Error("vt read exited 1: denied"));
    }),
  });
  return { secrets: gated, approve: () => approve(), refuse: () => refuse() };
}

/** The shape main.ts wires: the middleware first, then a route that reads the store. */
function appOver(secrets: Secrets): Hono {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: String(err) }, 500));
  app.use("*", untilUnlockSettled(secrets));
  app.get("/api/sessions", (c) => c.json({ sealed: secrets.encrypt("x").startsWith("v1:") }));
  return app;
}

describe("requests during the boot's unlock", () => {
  it("wait for the vt approval instead of failing on a locked store", async () => {
    const { secrets, approve } = await vtBoot();
    const app = appOver(secrets);
    void secrets.unlock();
    const pending = Promise.resolve(app.request("/api/sessions"));
    let answered = false;
    void pending.then(() => { answered = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    approve();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sealed: true });
  });

  it("go through once the unlock is refused, so the Console can say why", async () => {
    const { secrets, refuse } = await vtBoot();
    const app = appOver(secrets);
    secrets.unlock().catch(() => undefined);
    const pending = app.request("/api/sessions");
    refuse();
    const res = await pending;
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("secrets locked: Error: vt read exited 1: denied");
  });
});
