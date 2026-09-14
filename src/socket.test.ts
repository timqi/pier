import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownSecret, VaultLocked, type Resolved } from "./vault.js";
import { servePier, type SocketHosts } from "./socket.js";

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

const KNOWN = ["s1", "s2"];

function start(path = sockPath(), over: Partial<SocketHosts> & { locked?: boolean } = {}): { path: string; calls: string[] } {
  const calls: string[] = [];
  const server = servePier({
    vault: {
      resolve(names, by) {
        calls.push(`${names.join(",")} by ${by ?? ""}`);
        if (over.locked) throw new VaultLocked("unlock() has not run");
        const out: Resolved = {};
        for (const name of names) {
          const hit = STORE[name];
          if (!hit) throw new UnknownSecret(name);
          out[name] = hit;
        }
        return out;
      },
    },
    fileUrl: (name) => `https://pier.example/#/settings/vault?name=${name}`,
    task: async (params, caller) => {
      calls.push(`task by ${caller}`);
      return { echo: params, caller };
    },
    web: async (params, caller) => {
      calls.push(`web by ${caller}`);
      return { text: `searched ${JSON.stringify(params)}` };
    },
    knows: async (id) => KNOWN.includes(id),
    ...over,
  }, path);
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

describe("cli socket", () => {
  it("requires the caller's session on every route, and knows it or refuses", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    for (const url of ["/resolve", "/task", "/web"]) {
      expect(await call(path, JSON.stringify({ names: ["A"], params: {} }), "POST", url))
        .toEqual({ status: 400, body: { error: "PIER_SESSION_ID is required" } });
      expect(await call(path, JSON.stringify({ sessionId: "", names: ["A"] }), "POST", url))
        .toEqual({ status: 400, body: { error: "PIER_SESSION_ID is required" } });
      expect(await call(path, JSON.stringify({ sessionId: "nope", names: ["A"], params: {} }), "POST", url))
        .toEqual({ status: 403, body: { error: "nope is not a session of this Pier" } });
    }
    expect(calls).toEqual([]);
  });

  it("resolves names for the caller and names its session in the log line", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A", "R"], sessionId: "s1" }));
    expect(res).toEqual({ status: 200, body: { values: STORE } });
    expect(calls).toEqual(["A,R by session s1"]);
  });

  it("forwards task params verbatim under the caller's session and returns the tool's result", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    const params = { operation: "run", prompt: "Review", launch: { thinking: "high" }, tasks: undefined };
    const res = await call(path, JSON.stringify({ sessionId: "s2", params }), "POST", "/task");
    expect(res).toEqual({ status: 200, body: { result: { echo: { operation: "run", prompt: "Review", launch: { thinking: "high" } }, caller: "s2" } } });
    expect(calls).toEqual(["task by s2"]);
  });

  it("runs a web search under the caller's session and answers its text", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ sessionId: "s2", params: { op: "search", query: "pier" } }), "POST", "/web");
    expect(res).toEqual({ status: 200, body: { result: { text: 'searched {"op":"search","query":"pier"}' } } });
    expect(calls).toEqual(["web by s2"]);
  });

  it("answers 422 with the tool's own words when it refuses", async () => {
    const { path } = start(sockPath(), {
      task: async () => {
        throw new Error("session does not own this run");
      },
    });
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ sessionId: "s1", params: { operation: "cancel", run_id: "r" } }), "POST", "/task");
    expect(res).toEqual({ status: 422, body: { error: "session does not own this run" } });
  });

  it("answers 404 with the Console deep link for a name nobody filed", async () => {
    const { path } = start();
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A", "MISSING"], sessionId: "s1" }));
    expect(res).toEqual({
      status: 404,
      body: { error: "no secret named MISSING", file: "https://pier.example/#/settings/vault?name=MISSING" },
    });
  });

  it("answers 423 while the store is locked, with the reason", async () => {
    const { path } = start(sockPath(), { locked: true });
    await listening(servers[0]!);
    const res = await call(path, JSON.stringify({ names: ["A"], sessionId: "s1" }));
    expect(res).toEqual({ status: 423, body: { error: "locked — unlock() has not run" } });
  });

  it("refuses anything that is not a POST to a route it has, with a JSON object of vault names", async () => {
    const { path, calls } = start();
    await listening(servers[0]!);
    expect((await call(path, "", "GET", "/resolve")).status).toBe(404);
    expect((await call(path, "{}", "POST", "/other")).status).toBe(404);
    expect((await call(path, "not json")).status).toBe(400);
    expect((await call(path, JSON.stringify({ sessionId: "s1", names: [] }))).status).toBe(400);
    expect((await call(path, JSON.stringify({ sessionId: "s1", names: ["lower"] }))).status).toBe(400);
    expect((await call(path, JSON.stringify({ sessionId: "s1", names: "A" }))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 413 to a body past 64 KiB, and 500 for a failure that is neither name nor lock", async () => {
    const { path } = start(sockPath(), {
      vault: {
        resolve() {
          throw new Error("disk gone");
        },
      },
    });
    await listening(servers[0]!);
    expect(await call(path, JSON.stringify({ sessionId: "s1", names: ["A"], pad: "x".repeat(70_000) })))
      .toEqual({ status: 413, body: { error: "body exceeds 64 KiB" } });
    const answer = await call(path, JSON.stringify({ sessionId: "s1", names: ["A"] }));
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
