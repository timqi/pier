import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Secrets, type VtClient } from "./secrets.js";

let dir: string;
let path: string;

/** A vt that "protects" the KEK by reversing it — enough to prove the record,
 *  not the plaintext, is what lands on disk. */
const fakeVt = (): VtClient & { creates: number; reads: number } => {
  const vt = {
    creates: 0,
    reads: 0,
    async create(plaintext: string) {
      vt.creates++;
      return `vt://0${Buffer.from(plaintext).toString("base64url")}`;
    },
    async read(record: string) {
      vt.reads++;
      return Buffer.from(record.slice("vt://0".length), "base64url").toString();
    },
    async doctor() {
      return "vt doctor — fake";
    },
  };
  return vt;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-secrets-"));
  path = join(dir, "master.key");
});

describe("first boot", () => {
  it("a read error other than ENOENT throws and never recreates the key file", async () => {
    // EISDIR stands in for EACCES: any non-missing read failure must refuse,
    // not rename a fresh key over the existing one — that would destroy the
    // DEK and every sealed credential.
    mkdirSync(path);
    const s = new Secrets(path, fakeVt());
    await expect(s.unlock()).rejects.toThrow(/EISDIR/);
    expect(s.state).toBe("locked");
    expect(statSync(path).isDirectory()).toBe(true); // nothing written over it
    expect(() => s.encrypt("x")).toThrow(/EISDIR/); // the reason is remembered
  });

  it("creates master.key in file mode, 0600, and round-trips", async () => {
    const s = new Secrets(path, fakeVt());
    expect(s.state).toBe("locked");
    await s.unlock();
    expect(s.state).toBe("unlocked");
    expect(s.mode).toBe("file");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const blob = s.encrypt("xoxb-slack-token");
    expect(blob).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(blob).not.toContain("xoxb");
    expect(s.decrypt(blob)).toBe("xoxb-slack-token");
  });

  it("a second process unlocks the same file and reads the same blobs", async () => {
    const a = new Secrets(path, fakeVt());
    await a.unlock();
    const blob = a.encrypt("shared");
    const b = new Secrets(path, fakeVt());
    await b.unlock();
    expect(b.decrypt(blob)).toBe("shared");
  });
});

describe("locked behaviour", () => {
  it("refuses encrypt/decrypt with the reason", async () => {
    const s = new Secrets(path, fakeVt());
    expect(() => s.encrypt("x")).toThrow(/secrets locked: unlock\(\) has not run/);
    writeFileSync(path, "{corrupt");
    await expect(s.unlock()).rejects.toThrow();
    expect(() => s.encrypt("x")).toThrow(/secrets locked: SyntaxError/);
  });

  it("stays locked when vt refuses, and says so", async () => {
    const vt = fakeVt();
    vt.read = async () => {
      throw new Error("approval denied on phone");
    };
    const a = new Secrets(path, fakeVt());
    await a.unlock();
    await a.rotateKek("vt");
    const b = new Secrets(path, vt);
    await expect(b.unlock()).rejects.toThrow(/approval denied/);
    expect(b.state).toBe("locked");
    expect(() => b.decrypt("v1:x:a:b:c")).toThrow(/approval denied/);
  });
});

describe("rotate", () => {
  it("KEK rotate keeps every envelope valid and changes the file", async () => {
    const s = new Secrets(path, fakeVt());
    await s.unlock();
    const blob = s.encrypt("survives rotation");
    const before = readFileSync(path, "utf8");
    await s.rotateKek();
    expect(readFileSync(path, "utf8")).not.toBe(before);
    expect(s.decrypt(blob)).toBe("survives rotation");
    // And a fresh process agrees.
    const again = new Secrets(path, fakeVt());
    await again.unlock();
    expect(again.decrypt(blob)).toBe("survives rotation");
  });

  it("enters vt mode via vt create; the raw key leaves the disk", async () => {
    const vt = fakeVt();
    const s = new Secrets(path, vt);
    await s.unlock();
    const blob = s.encrypt("now vt-protected");
    await s.rotateKek("vt");
    expect(s.mode).toBe("vt");
    expect(vt.creates).toBe(1);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { kek: string };
    expect(onDisk.kek).toMatch(/^vt:\/\//);
    const fresh = new Secrets(path, vt);
    await fresh.unlock();
    expect(vt.reads).toBe(1);
    expect(fresh.decrypt(blob)).toBe("now vt-protected");
  });

  it("leaves vt mode back to file mode explicitly", async () => {
    const vt = fakeVt();
    const s = new Secrets(path, vt);
    await s.unlock();
    await s.rotateKek("vt");
    const blob = s.encrypt("x");
    await s.rotateKek("file");
    expect(s.mode).toBe("file");
    const fresh = new Secrets(path, fakeVt());
    await fresh.unlock(); // no vt.read needed
    expect(fresh.decrypt(blob)).toBe("x");
  });
});

describe("tamper", () => {
  it("rejects a flipped ciphertext bit and a blob moved between slots", async () => {
    const s = new Secrets(path, fakeVt());
    await s.unlock();
    const blob = s.encrypt("secret");
    const [v, id, iv, ct, tag] = blob.split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0]! ^= 1;
    expect(() => s.decrypt([v, id, iv, flipped.toString("base64"), tag].join(":"))).toThrow();
    expect(() => s.decrypt(`v1:deadbeef:${iv}:${ct}:${tag}`)).toThrow(/unknown key/);
    expect(() => s.decrypt("garbage")).toThrow(/not a v1/);
  });
});
