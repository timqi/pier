// TerminalHub against a real pty and fake sockets: the seam under test is the
// mirror/replay/reap policy, not node-pty itself — but a mocked pty would skip
// the part most likely to break (spawn, resize, exit plumbing).

import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openDb } from "../db.js";
import { AuthStore, registerAuthRoutes } from "./auth.js";
import {
  attachTerminal,
  TerminalHub,
  type HubOptions,
  type TermConn,
  type TermSocket,
} from "./terminal.js";

class FakeSocket implements TermSocket {
  frames: (Buffer | string)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;

  send(data: Buffer | string): void {
    this.frames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Everything binary received so far, as text. */
  get output(): string {
    return this.frames.filter((f) => Buffer.isBuffer(f)).map(String).join("");
  }

  controls(): { t: string; [k: string]: unknown }[] {
    return this.frames
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as { t: string });
  }
}

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pier-term-")));
// `sh` with a fixed prompt: the assertions read echoed output, not the prompt.
const hub = (opts: Omit<HubOptions, "shell"> = {}): TerminalHub =>
  new TerminalHub({ shell: "/bin/sh", ...opts });

let hubs: TerminalHub[] = [];
const make = (opts?: Omit<HubOptions, "shell">): TerminalHub => {
  const h = hub(opts);
  hubs.push(h);
  return h;
};

afterEach(() => {
  for (const h of hubs) h.close();
  hubs = [];
});

describe("terminal WebSocket", () => {
  it("detaches an early disconnect and revokes a live client on password change", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "pier-term-auth-")), "pier.db"));
    let printed = "";
    const auth = new AuthStore(db, (message) => {
      printed = message;
    });
    const password = printed.match(/[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}/)?.[0] ?? "";
    const app = new Hono();
    registerAuthRoutes(app, auth);
    const login = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, next: "/" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    const terminal = attachTerminal(server, auth, { heartbeatMs: 100 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const malformed = await new Promise<string>((resolve, reject) => {
      const raw = createConnection({ host: "127.0.0.1", port }, () =>
        raw.write("GET http://[ HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
      );
      let response = "";
      raw.on("data", (chunk) => {
        response += String(chunk);
      });
      raw.on("close", () => resolve(response));
      raw.on("error", reject);
    });
    expect(malformed).toContain("400 Bad Request");
    const url = `ws://127.0.0.1:${port}/api/terminal?cwd=${encodeURIComponent(cwd)}`;
    const connect = async (autoPong = true): Promise<WebSocket> => {
      const ws = new WebSocket(url, {
        autoPong,
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("close", () => reject(new Error("socket closed before open")));
      });
      return ws;
    };
    try {
      const early = await connect();
      const earlyClosed = new Promise<void>((resolve) => early.once("close", () => resolve()));
      early.terminate();
      await earlyClosed;
      await until(() => terminal.size === 1);
      terminal.sweep(Date.now() + 2 * 60 * 60_000);
      await until(() => terminal.size === 0);

      const halfOpen = await connect(false);
      let pings = 0;
      halfOpen.on("ping", () => pings++);
      const heartbeatClose = new Promise<number>((resolve) =>
        halfOpen.once("close", (code) => resolve(code)),
      );
      const heartbeatResult = await Promise.race([
        heartbeatClose,
        new Promise<string>((resolve) => setTimeout(() => resolve(`open after ${pings} pings`), 1000)),
      ]);
      expect(heartbeatResult).toBe(1006); // terminate: no close frame
      await until(() => {
        terminal.sweep(Date.now() + 2 * 60 * 60_000);
        return terminal.size === 0;
      });

      const revoked = await connect();
      await until(() => terminal.size === 1);
      await new Promise<void>((resolve) => revoked.once("ping", () => resolve()));
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        revoked.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
      );
      auth.setPassword("replacement-password");
      await expect(closed).resolves.toEqual({ code: 1008, reason: "password changed" });
    } finally {
      terminal.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

describe("TerminalHub", () => {
  it("runs a shell and mirrors output to every attached socket", async () => {
    const h = make();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const connA = await h.attach(cwd, a);
    const connB = await h.attach(cwd, b);
    expect(connA).not.toBeNull();
    expect(connB).not.toBeNull();
    expect(h.size).toBe(1); // same cwd, same shell
    connA!.message(JSON.stringify({ t: "in", d: "echo mirrored-$((20+22))\r" }));
    await until(() => a.output.includes("mirrored-42"));
    await until(() => b.output.includes("mirrored-42"));
  });

  it("detaches a slow mirror without pausing healthy clients", async () => {
    const h = make();
    const fast = new FakeSocket();
    const slow = new FakeSocket();
    const conn = (await h.attach(cwd, fast))!;
    await h.attach(cwd, slow);
    slow.bufferedAmount = 5 * 1024 * 1024;
    conn.message(JSON.stringify({ t: "in", d: "echo fast-stays-live\r" }));
    await until(() => fast.output.includes("fast-stays-live"));
    await until(() => slow.closed !== null);
    expect(slow.closed).toEqual({ code: 1013, reason: "client too slow" });
    conn.message(JSON.stringify({ t: "in", d: "echo still-responsive\r" }));
    await until(() => fast.output.includes("still-responsive"));
  });

  it("does not inherit the parent tmux or SSH client identity", async () => {
    const inherited = {
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      SSH_TTY: process.env.SSH_TTY,
      SSH_CLIENT: process.env.SSH_CLIENT,
      SSH_CONNECTION: process.env.SSH_CONNECTION,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    };
    Object.assign(process.env, {
      TMUX: "/tmp/tmux-parent,1,0",
      TMUX_PANE: "%9",
      SSH_TTY: "/dev/pts/1",
      SSH_CLIENT: "10.0.0.1 1234 22",
      SSH_CONNECTION: "10.0.0.1 1234 10.0.0.2 22",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    const h = make();
    const socket = new FakeSocket();
    let conn: TermConn | null;
    try {
      conn = await h.attach(cwd, socket);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    conn!.message(JSON.stringify({
      t: "in",
      d: "printf 'env=%s|%s|%s|%s|%s;agent=%s\\n' \"$TMUX\" \"$TMUX_PANE\" \"$SSH_TTY\" \"$SSH_CLIENT\" \"$SSH_CONNECTION\" \"$SSH_AUTH_SOCK\"\r",
    }));
    await until(() => socket.output.includes("agent=/tmp/agent.sock"));
    expect(socket.output).toContain("env=||||;agent=/tmp/agent.sock");
  });

  it("replays the ring to a late attach", async () => {
    const h = make();
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    conn.message(JSON.stringify({ t: "in", d: "echo replay-me\r" }));
    await until(() => a.output.includes("replay-me"));
    conn.detach();
    const b = new FakeSocket();
    await h.attach(cwd, b);
    expect(b.output).toContain("replay-me");
  });

  it("types the startup command into each new shell, once per pty and read at spawn", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pier-term-init-")));
    const marker = join(dir, "runs");
    const runs = (): string => {
      try {
        return readFileSync(marker, "utf8");
      } catch {
        return "";
      }
    };
    let command = `printf a >> ${marker}`;
    const h = make({ initCommand: () => command });
    const a = new FakeSocket();
    const first = (await h.attach(dir, a))!;
    await until(() => runs() === "a");

    // A page joining the same cwd attaches to that shell; only a spawn runs it.
    first.detach();
    const b = new FakeSocket();
    const second = (await h.attach(dir, b))!;
    second.message(JSON.stringify({ t: "in", d: "echo attached\r" }));
    await until(() => b.output.includes("attached"));
    expect(runs()).toBe("a");

    // Read per spawn: an edit in the Console reaches the next shell, no restart.
    command = `printf b >> ${marker}`;
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pier-term-init-")));
    await h.attach(other, new FakeSocket());
    await until(() => runs() === "ab");
  });

  it("leaves a plain shell alone when no startup command is set", async () => {
    const h = make();
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    conn.message(JSON.stringify({ t: "in", d: "echo only-mine\r" }));
    await until(() => a.output.includes("only-mine"));
    expect(a.output.trimStart().startsWith("echo only-mine")).toBe(true);
  });

  it("applies the last resize", async () => {
    const h = make();
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    conn.message(JSON.stringify({ t: "resize", cols: 91, rows: 33 }));
    conn.message(JSON.stringify({ t: "in", d: "stty size\r" }));
    await until(() => a.output.includes("33 91"));
  });

  it("drops malformed frames without killing the shell", async () => {
    const h = make();
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    conn.message("not json");
    conn.message("null");
    conn.message(JSON.stringify({ t: "resize", cols: 0, rows: -1 }));
    conn.message(JSON.stringify({ t: "in", d: "echo still-alive\r" }));
    await until(() => a.output.includes("still-alive"));
  });

  it("restarts on request: every attached page is told, and the next attach is a new shell", async () => {
    const h = make();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    await h.attach(cwd, b);
    conn.message(JSON.stringify({ t: "in", d: "echo before-restart\r" }));
    await until(() => a.output.includes("before-restart"));

    conn.message(JSON.stringify({ t: "restart" }));
    await until(() => h.size === 0);
    for (const sock of [a, b]) {
      expect(sock.controls().some((f) => f.t === "exit")).toBe(true);
      expect(sock.closed).not.toBeNull();
    }

    const c = new FakeSocket();
    const fresh = (await h.attach(cwd, c))!;
    expect(c.output).not.toContain("before-restart"); // a new pty, a new ring
    fresh.message(JSON.stringify({ t: "in", d: "echo after-restart\r" }));
    await until(() => c.output.includes("after-restart"));
  });

  it("refuses a bad cwd with an error frame, never silently", async () => {
    const h = make();
    for (const bad of ["relative/path", "/definitely/not/a/dir"]) {
      const s = new FakeSocket();
      expect(await h.attach(bad, s)).toBeNull();
      expect(s.controls()[0]?.t).toBe("error");
      expect(s.closed).not.toBeNull();
    }
  });

  it("caps concurrent shells and names the refusal", async () => {
    const h = make({ maxTerms: 1 });
    await h.attach(cwd, new FakeSocket());
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pier-term-")));
    const s = new FakeSocket();
    expect(await h.attach(other, s)).toBeNull();
    expect(s.controls()[0]?.message).toContain("close one first");
  });

  it("tells every client when the shell exits, then forgets it", async () => {
    const h = make();
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    conn.message(JSON.stringify({ t: "in", d: "exit 3\r" }));
    await until(() => h.size === 0);
    expect(a.controls().some((c) => c.t === "exit" && c.code === 3)).toBe(true);
    expect(a.closed?.code).toBe(1000);
  });

  it("does not spawn a shell after shutdown starts", async () => {
    const h = make();
    h.close();
    const socket = new FakeSocket();
    expect(await h.attach(cwd, socket)).toBeNull();
    expect(h.size).toBe(0);
    expect(socket.controls()[0]?.message).toBe("terminal server is stopping");
    expect(socket.closed?.code).toBe(1012);
  });

  it("reaps a shell detached past the idle window, and only then", async () => {
    const h = make({ idleMs: 60_000 });
    const a = new FakeSocket();
    const conn = (await h.attach(cwd, a))!;
    h.sweep(Date.now() + 120_000); // attached: never idle
    expect(h.size).toBe(1);
    conn.detach();
    h.sweep(Date.now() + 30_000);
    expect(h.size).toBe(1);
    h.sweep(Date.now() + 120_000);
    await until(() => h.size === 0); // kill lands via onExit
  });
});
