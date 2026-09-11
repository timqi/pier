import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { Secrets, type VtClient } from "./secrets.js";
import { UnknownSecret, Vault, VaultLocked } from "./vault.js";

/** A vt whose record is the base64url of the plaintext — a handle the test can
 *  recognize, never the plaintext itself. */
const fakeVt = (): VtClient & { creates: string[] } => {
  const vt = {
    creates: [] as string[],
    async create(plaintext: string) {
      vt.creates.push(plaintext);
      return `vt://rec-${Buffer.from(plaintext).toString("base64url")}`;
    },
    async read(record: string) {
      return Buffer.from(record.slice("vt://rec-".length), "base64url").toString();
    },
    async doctor() {
      return "vt doctor — fake";
    },
  };
  return vt;
};

let db: DatabaseSync;
let secrets: Secrets;
let vt: ReturnType<typeof fakeVt>;
let vault: Vault;

const stored = (name: string): string | undefined =>
  (db.prepare("SELECT value FROM vault WHERE name = ?").get(name) as { value: string } | undefined)?.value;

beforeEach(async () => {
  db = openDb(":memory:");
  vt = fakeVt();
  secrets = new Secrets(join(mkdtempSync(join(tmpdir(), "pier-vault-")), "master.key"), vt);
  await secrets.unlock();
  vault = new Vault(secrets, db, vt);
});

describe("put", () => {
  it("seals an auto secret so the table never holds the plaintext", async () => {
    await vault.put("SLACK_TOKEN", "auto", "xoxb-secret");
    expect(stored("SLACK_TOKEN")).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(stored("SLACK_TOKEN")).not.toContain("xoxb");
    expect(vault.list()).toEqual([{ name: "SLACK_TOKEN", level: "auto", updatedAt: expect.any(Number) }]);
    expect(vt.creates).toEqual([]);
  });

  it("stores an approve secret as the record vt created", async () => {
    await vault.put("DEPLOY_KEY", "approve", "ssh-ed25519 AAAA");
    expect(vt.creates).toEqual(["ssh-ed25519 AAAA"]);
    expect(stored("DEPLOY_KEY")).toMatch(/^vt:\/\//);
    expect(vault.list()).toEqual([{ name: "DEPLOY_KEY", level: "approve", updatedAt: expect.any(Number) }]);
  });

  it("refuses a name that is not an env-var name, and an empty value", async () => {
    for (const bad of ["lower", "1ABC", "A-B", "A".repeat(65), ""]) {
      await expect(vault.put(bad, "auto", "x")).rejects.toThrow(/not a vault name/);
    }
    await expect(vault.put("EMPTY", "auto", "")).rejects.toThrow(/empty value/);
    expect(vault.list()).toEqual([]);
  });

  it("overwrites by name: rotation, not a second row", async () => {
    await vault.put("TOKEN", "auto", "one");
    const first = vault.list()[0]!;
    await vault.put("TOKEN", "approve", "two");
    expect(vault.list()).toHaveLength(1);
    expect(vault.list()[0]!.level).toBe("approve");
    expect(vault.list()[0]!.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(vault.resolve(["TOKEN"])).toEqual({ TOKEN: { kind: "record", value: stored("TOKEN") } });
  });

  it("rejects a vt that did not answer with a record", async () => {
    vt.create = async () => "created ok";
    await expect(vault.put("X", "approve", "v")).rejects.toThrow(/vt:\/\/ record/);
    expect(vault.list()).toEqual([]);
  });

  it("seal is put at auto, synchronous, under the same rules", () => {
    vault.seal("SLACK_TOKEN", "xoxb-secret");
    expect(stored("SLACK_TOKEN")).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(vault.list()[0]!.level).toBe("auto");
    expect(() => vault.seal("lower", "x")).toThrow(/not a vault name/);
    expect(() => vault.seal("EMPTY", "")).toThrow(/empty value/);
  });
});

describe("get", () => {
  it("answers one name with its plaintext or record, undefined when unfiled", async () => {
    await vault.put("A", "auto", "plain-a");
    await vault.put("B", "approve", "plain-b");
    expect(vault.get("A")).toBe("plain-a");
    expect(vault.get("B")).toBe(stored("B"));
    expect(vault.get("MISSING")).toBeUndefined();
  });

  it("throws the locked reason for a sealed row, and nothing for an unfiled name", async () => {
    await vault.put("A", "auto", "plain-a");
    const locked = new Vault(new Secrets(join(mkdtempSync(join(tmpdir(), "pier-vault-")), "master.key"), vt), db, vt);
    expect(() => locked.get("A")).toThrow(/secrets locked/);
    expect(locked.get("MISSING")).toBeUndefined();
  });
});

describe("resolve", () => {
  it("returns plaintext for auto rows and the record, unchanged, for approve rows", async () => {
    await vault.put("A", "auto", "plain-a");
    await vault.put("B", "approve", "plain-b");
    expect(vault.resolve(["A", "B"], "pid 42")).toEqual({
      A: { kind: "plain", value: "plain-a" },
      B: { kind: "record", value: stored("B") },
    });
    expect(stored("B")).not.toContain("plain-b");
  });

  it("names the unknown secret and returns nothing for the known ones", async () => {
    await vault.put("A", "auto", "plain-a");
    let caught: unknown;
    try {
      vault.resolve(["A", "MISSING"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownSecret);
    expect((caught as UnknownSecret).secret).toBe("MISSING");
    expect((caught as Error).message).toBe("no secret named MISSING");
  });

  it("refuses sealed rows while locked, with the reason, and still serves records", async () => {
    await vault.put("A", "auto", "plain-a");
    await vault.put("B", "approve", "plain-b");
    const locked = new Vault(new Secrets(join(mkdtempSync(join(tmpdir(), "pier-vault-")), "master.key"), vt), db, vt);
    expect(locked.resolve(["B"])).toEqual({ B: { kind: "record", value: stored("B") } });
    let caught: unknown;
    try {
      locked.resolve(["B", "A"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultLocked);
    expect((caught as Error).message).toBe("locked — unlock() has not run");
  });
});

describe("remove", () => {
  it("deletes the row and says whether there was one", async () => {
    await vault.put("A", "auto", "plain-a");
    expect(vault.remove("A")).toBe(true);
    expect(vault.remove("A")).toBe(false);
    expect(vault.list()).toEqual([]);
    expect(() => vault.resolve(["A"])).toThrow("no secret named A");
  });
});
