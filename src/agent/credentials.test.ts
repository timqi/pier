import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { CredentialStore, type ProviderCredential } from "./credentials.js";

let dir: string;
let secrets: Secrets;
let db: ReturnType<typeof openDb>;

const store = () => new CredentialStore(db, secrets, dir);

const row = (key: string) =>
  (db.prepare("SELECT value FROM credentials WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;

const oauth = (access: string): ProviderCredential => ({
  type: "oauth",
  access,
  refresh: "r-1",
  expires: 9999999999999,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pier-credentials-"));
  db = openDb(":memory:");
  secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock(); // file mode: no vt involved
});

describe("seal and unseal", () => {
  it("stores sealed rows and round-trips the credential", async () => {
    const s = store();
    await s.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-secret" }));
    expect(row("anthropic")).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(row("anthropic")).not.toContain("sk-ant");
    expect(await s.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-secret" });
    expect(await s.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });

  it("honors a legacy plaintext row and re-seals it on the next write", async () => {
    db.prepare("INSERT INTO credentials(key, value) VALUES (?, ?)").run(
      "openai",
      JSON.stringify({ type: "api_key", key: "sk-plain" }),
    );
    const s = store();
    expect(await s.read("openai")).toEqual({ type: "api_key", key: "sk-plain" });
    await s.modify("openai", async (current) => current && { ...current, key: "sk-new" });
    expect(row("openai")).toMatch(/^v1:/);
    expect(await s.read("openai")).toEqual({ type: "api_key", key: "sk-new" });
  });
});

describe("write-through persistence", () => {
  it("an OAuth refresh written through modify() survives a new store", async () => {
    await store().modify("anthropic", async () => oauth("tok-old"));
    // pi-ai refreshes inside modify(): fn sees the current token, returns the new.
    const refreshed = await store().modify("anthropic", async (current) => {
      expect(current).toEqual(oauth("tok-old"));
      return oauth("tok-new");
    });
    expect(refreshed).toEqual(oauth("tok-new"));
    expect(await store().read("anthropic")).toEqual(oauth("tok-new"));
  });

  it("fn returning undefined leaves the row unchanged", async () => {
    const s = store();
    await s.modify("anthropic", async () => oauth("tok"));
    const before = row("anthropic");
    expect(await s.modify("anthropic", async () => undefined)).toEqual(oauth("tok"));
    expect(row("anthropic")).toBe(before);
  });

  it("delete removes the row", async () => {
    const s = store();
    await s.modify("anthropic", async () => oauth("tok"));
    await s.delete("anthropic");
    expect(row("anthropic")).toBeUndefined();
    expect(await s.read("anthropic")).toBeUndefined();
    expect(await s.list()).toEqual([]);
  });
});

describe("legacy auth.json import", () => {
  it("imports entries sealed, renames the file, once", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(
      path,
      JSON.stringify({
        anthropic: oauth("tok-file"),
        openai: { type: "api_key", key: "sk-file" },
      }),
    );
    const s = store();
    expect(await s.read("openai")).toEqual({ type: "api_key", key: "sk-file" });
    expect(row("anthropic")).toMatch(/^v1:/);
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(`${path}.imported`, "utf8"))).toHaveProperty("anthropic");
    // A later read does not resurrect the receipt.
    await s.delete("openai");
    expect(await store().read("openai")).toBeUndefined();
  });

  it("rejects a malformed auth.json by name, and changes nothing", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, "{broken");
    await expect(store().read("x")).rejects.toThrow(/auth\.json exists but is not valid JSON/);
    expect(existsSync(path)).toBe(true);
  });
});

describe("locked refusal", () => {
  it("read, modify and assertUnlocked all fail with the reason", async () => {
    await store().modify("anthropic", async () => oauth("tok"));
    const locked = new CredentialStore(db, new Secrets(join(dir, "master.key")), dir);
    expect(() => locked.assertUnlocked()).toThrow(/secrets locked: unlock\(\) has not run/);
    await expect(locked.read("anthropic")).rejects.toThrow(/secrets locked/);
    await expect(locked.modify("x", async () => oauth("t"))).rejects.toThrow(/secrets locked/);
  });

  it("a locked import fails loudly, keeps auth.json, and retries after unlock", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: "sk" } }));
    const lockedSecrets = new Secrets(join(dir, "master.key"));
    const s = new CredentialStore(db, lockedSecrets, dir);
    await expect(s.read("openai")).rejects.toThrow(/secrets locked/);
    expect(existsSync(path)).toBe(true); // never renamed before it landed
    await lockedSecrets.unlock();
    expect(await s.read("openai")).toEqual({ type: "api_key", key: "sk" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.imported`)).toBe(true);
  });
});
