import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownSecret, VaultLocked, type Resolved } from "./vault.js";
import { serveVault } from "./vault-socket.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** Short: a Unix socket path is capped near 108 bytes. */
const sockPath = (): string => join(mkdtempSync(join(tmpdir(), "vs-")), "v.sock");

const STORE: Resolved = {
  A: { kind: "plain", value: "plain-a" },
  R: { kind: "record", value: "vt://rec" },
};

function start(path = sockPath(), locked = false): { path: string; calls: string[] } {
  const calls: string[] = [];
  const server = serveVault({
    resolve(names, by) {
      calls.push(`${names.join(",")} by ${by ?? ""}`);
      if (locked) throw new VaultLocked("unlock() has not run");
      const out: Resolved = {};
      for (const name of names) {
        const hit = STORE[name];
        if (!hit) throw new UnknownSecret(name);
        out[name] = hit;
      }
      return out;
    },
  }, (name) => `https://pier.example/#/settings/vault?name=${name}`, path);
  servers.push(server);
  return { path, calls };
}

const listening = (server: Server): Promise<void> =>
  server.listening ? Promise.resolve() : new Promise((done) => server.once("listening", () => done()));

function call(path: string, body: string, method = "POST", url = "/resolve"): Promise<{ status: number; body: unknown }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: path, method, path: url }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("vault socket", () => {
  it("resolves names for the caller and names it in the log line", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A", "R"], pid: 4242 }));
    expect(res).toEqual({ status: 200, body: { values: STORE } });
    expect(calls).toEqual(["A,R by pid 4242"]);
  });

  it("answers 404 with the Console deep link for a name nobody filed", async () => {
    const { path } = start();
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A", "MISSING"] }));
    expect(res).toEqual({
      status: 404,
      body: { error: "no secret named MISSING", file: "https://pier.example/#/settings/vault?name=MISSING" },
    });
  });

  it("answers 423 while the store is locked, with the reason", async () => {
    const { path } = start(sockPath(), true);
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A"] }));
    expect(res).toEqual({ status: 423, body: { error: "locked — unlock() has not run" } });
  });

  it("refuses anything that is not POST /resolve with vault names", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    expect((await call(path, "", "GET", "/resolve")).status).toBe(404);
    expect((await call(path, "{}", "POST", "/other")).status).toBe(404);
    expect((await call(path, "not json")).status).toBe(400);
    expect((await call(path, JSON.stringify({ names: [] }))).status).toBe(400);
    expect((await call(path, JSON.stringify({ names: ["lower"] }))).status).toBe(400);
    expect((await call(path, JSON.stringify({ names: "A" }))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("drops a body past 64 KB without reading it, and is 500 for a failure that is neither name nor lock", async () => {
    const path = sockPath();
    const server = serveVault({
      resolve() {
        throw new Error("disk gone");
      },
    }, () => "", path);
    servers.push(server);
    await listening(server);
    await expect(call(path, JSON.stringify({ names: ["A".repeat(64), "B".repeat(64), "C"], pad: "x".repeat(70_000) })))
      .rejects.toThrow(/socket hang up|ECONNRESET|EPIPE/);
    const answer = await call(path, JSON.stringify({ names: ["A"] }));
    expect(answer).toEqual({ status: 500, body: { error: "Error: disk gone" } });
  });

  it("is 0600, replaces a stale socket file, and goes when the server closes", async () => {
    const path = sockPath();
    writeFileSync(path, "stale");
    start(path);
    await listening(servers[0]!);
    expect(statSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await new Promise((done) => servers.pop()!.close(done));
    // Node unlinks a listening pipe on close; the exit hook covers the crash path.
    expect(existsSync(path)).toBe(false);
  });
});
