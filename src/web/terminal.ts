// Terminal backend: one shell pty per project cwd, mirrored to every attached
// WebSocket. The pty outlives the page — closing a tab only detaches, and a
// later attach replays the recent output ring; every attached page sees the
// same shell, and any of them may type (last resize wins). Detached for an
// hour → the shell is reaped; a Pier restart kills every pty (run tmux inside
// to survive that — durability is tmux's job, not ours). This is the one
// WebSocket surface: a keystroke is a round trip, which SSE cannot carry
// upstream. Everything else stays on the event stream.

import type { Server } from "node:http";
import { spawn, type IPty } from "node-pty";
import { WebSocketServer } from "ws";
import { logger } from "../log.js";
import { scoped } from "./fs.js";
import { ALL, upgradeAuthorized, type AuthStore } from "./auth.js";

const log = logger("terminal");

/** Live shells at once — a guard against forgotten spawns, not a quota. */
const MAX_TERMS = 8;
/** Recent output kept for reattach. Scrollback beyond it lives in the page. */
const RING_BYTES = 1024 * 1024;
const IDLE_MS = 60 * 60_000;
const SWEEP_MS = 60_000;
const HEARTBEAT_MS = 30_000;
/** A slow mirror is detached before its send queue grows without bound; a
 *  healthy page must never be paused behind it. Reattach replays the ring. */
const HIGH_WATER = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
// A Web Terminal is a new local tty, not the tmux/SSH client Pier happened to
// start under. Inheriting these can attach the shell back into Pier's parent
// tmux session; SSH_AUTH_SOCK deliberately stays so git/ssh keep working.
const PARENT_TERMINAL_ENV = ["TMUX", "TMUX_PANE", "SSH_TTY", "SSH_CLIENT", "SSH_CONNECTION"];
// Pier's own configuration is Pier's, not this shell's. `NODE_ENV=production`
// alone turns an `npm i` typed here into an install with no dev dependencies,
// and every `PI_*`/`PIER_*` would point a `pi` started here at Pier's own
// instance rather than the person's. Everything else is inherited on purpose:
// PATH, LANG, SSH_AUTH_SOCK and the session's XDG/DBUS handles are what make
// the shell usable, and on a service-managed instance nothing else supplies
// them.
const PIER_OWN_ENV = ["NODE_ENV", "PORT", "HOST"];
const PIER_OWN_PREFIX = /^PI(ER)?_/;

/** What the hub needs from a socket — `ws.WebSocket` satisfies it, tests fake it. */
export interface TermSocket {
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount: number;
}

/** One attached client's handle; the ws glue feeds frames in through it. */
export interface TermConn {
  message(text: string): void;
  detach(): void;
}

interface Term {
  pty: IPty;
  ring: Buffer[];
  ringBytes: number;
  clients: Set<TermSocket>;
  /** When the last client left — the reap clock. Attached → Infinity. */
  idleSince: number;
}

const send = (sock: TermSocket, data: Buffer | string): boolean => {
  try {
    sock.send(data);
    return true;
  } catch (err) {
    log.warn(`terminal socket send failed: ${String(err)}`);
    return false;
  }
};
const control = (sock: TermSocket, msg: object): boolean => send(sock, JSON.stringify(msg));

export interface HubOptions {
  shell?: string;
  idleMs?: number;
  maxTerms?: number;
  /** The operator's startup command, read at every spawn so an edit in the
   *  Console applies to the next shell without a restart. */
  initCommand?: () => string;
}

export class TerminalHub {
  readonly #terms = new Map<string, Term>();
  readonly #shell: string;
  readonly #idleMs: number;
  readonly #maxTerms: number;
  readonly #initCommand: () => string;
  readonly #sweeper: NodeJS.Timeout;
  readonly #closeListeners = new Set<() => void>();
  #closed = false;

  constructor(opts: HubOptions = {}) {
    this.#shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
    this.#idleMs = opts.idleMs ?? IDLE_MS;
    this.#maxTerms = opts.maxTerms ?? MAX_TERMS;
    this.#initCommand = opts.initCommand ?? (() => "");
    this.#sweeper = setInterval(() => this.sweep(Date.now()), SWEEP_MS);
    this.#sweeper.unref();
  }

  /** Attach a socket to `cwd`'s shell, spawning one if needed. A refusal is
   *  never silent: the socket gets a `{t:"error"}` frame and a close, and the
   *  caller gets `null`. */
  async attach(cwd: string, sock: TermSocket): Promise<TermConn | null> {
    let key: string;
    try {
      key = await scoped(cwd); // absolute, real, and a directory — or it throws
    } catch (err) {
      control(sock, { t: "error", message: String(err) });
      sock.close(1008, "bad cwd");
      return null;
    }
    if (this.#closed) {
      control(sock, { t: "error", message: "terminal server is stopping" });
      sock.close(1012, "server stopping");
      return null;
    }
    let term = this.#terms.get(key);
    if (!term) {
      if (this.#terms.size >= this.#maxTerms) {
        control(sock, { t: "error", message: `${this.#maxTerms} shells already running — close one first` });
        sock.close(1013, "too many shells");
        return null;
      }
      try {
        term = this.#spawn(key);
      } catch (err) {
        log.error(`spawn ${this.#shell} in ${key} failed`, err);
        control(sock, { t: "error", message: `could not start ${this.#shell}: ${String(err)}` });
        sock.close(1011, "spawn failed");
        return null;
      }
    }
    term.clients.add(sock);
    term.idleSince = Infinity;
    const conn: TermConn = {
      message: (text) => this.#message(key, sock, text),
      detach: () => {
        const t = this.#terms.get(key);
        if (!t || !t.clients.delete(sock)) return;
        if (t.clients.size === 0) t.idleSince = Date.now();
      },
    };
    try {
      if (term.ringBytes) sock.send(Buffer.concat(term.ring));
    } catch (err) {
      conn.detach();
      throw err;
    }
    return conn;
  }

  #spawn(cwd: string): Term {
    const env = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(env)) {
      if (PARENT_TERMINAL_ENV.includes(key) || PIER_OWN_ENV.includes(key) || PIER_OWN_PREFIX.test(key)) {
        delete env[key];
      }
    }
    const pty = spawn(this.#shell, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env,
    });
    const term: Term = { pty, ring: [], ringBytes: 0, clients: new Set(), idleSince: Infinity };
    this.#terms.set(cwd, term);
    log.info(`shell ${pty.pid} for ${cwd}`);
    // Typed in, not exec'd: the shell stays the parent, so quitting whatever
    // this starts leaves a usable prompt, and the echo plus any error is in
    // the ring where the person can see what ran. The tty buffers it until the
    // shell's first read, so no wait is needed. A reattach never repeats it —
    // this runs once per pty, which is once per cwd.
    const init = this.#initCommand().trim();
    if (init) pty.write(`${init}\r`);
    pty.onData((data) => {
      const chunk = Buffer.from(data);
      term.ring.push(chunk);
      term.ringBytes += chunk.byteLength;
      while (term.ringBytes > RING_BYTES && term.ring.length > 1) {
        term.ringBytes -= term.ring.shift()!.byteLength;
      }
      for (const client of term.clients) {
        if (client.bufferedAmount <= HIGH_WATER && send(client, chunk)) continue;
        term.clients.delete(client);
        client.close(1013, "client too slow");
        log.warn(`detached slow terminal client for ${cwd}`);
      }
      if (term.clients.size === 0 && term.idleSince === Infinity) term.idleSince = Date.now();
    });
    pty.onExit(({ exitCode }) => {
      log.info(`shell ${pty.pid} for ${cwd} exited (${exitCode})`);
      this.#terms.delete(cwd);
      for (const c of term.clients) {
        control(c, { t: "exit", code: exitCode });
        c.close(1000, "shell exited");
      }
      term.clients.clear();
    });
    return term;
  }

  /** One inbound frame. Malformed input is logged and dropped, never half-run. */
  #message(cwd: string, sock: TermSocket, text: string): void {
    const term = this.#terms.get(cwd);
    if (!term || !term.clients.has(sock)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      log.warn(`dropped unparseable frame for ${cwd}`);
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      log.warn(`dropped malformed frame for ${cwd}: ${text.slice(0, 80)}`);
      return;
    }
    const msg = raw as { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };
    if (msg.t === "in" && typeof msg.d === "string") {
      term.pty.write(msg.d);
      return;
    }
    // The only way a page can end a shell: everything attached to it is told by
    // the exit path below, exactly as if the shell had exited on its own.
    if (msg.t === "restart") {
      log.info(`shell ${term.pty.pid} for ${cwd} killed on request`);
      term.pty.kill();
      return;
    }
    if (
      msg.t === "resize" &&
      typeof msg.cols === "number" && typeof msg.rows === "number" &&
      Number.isInteger(msg.cols) && Number.isInteger(msg.rows) &&
      msg.cols >= 2 && msg.cols <= 500 && msg.rows >= 2 && msg.rows <= 200
    ) {
      term.pty.resize(msg.cols, msg.rows); // last resize wins, by design
      return;
    }
    log.warn(`dropped malformed frame for ${cwd}: ${text.slice(0, 80)}`);
  }

  /** Reap shells nobody has been attached to for `idleMs`. */
  sweep(now: number): void {
    for (const [cwd, term] of this.#terms) {
      if (now - term.idleSince < this.#idleMs) continue;
      log.info(`reaping idle shell ${term.pty.pid} for ${cwd}`);
      term.pty.kill(); // onExit above deletes and notifies
    }
  }

  get size(): number {
    return this.#terms.size;
  }

  onClose(listener: () => void): void {
    this.#closeListeners.add(listener);
  }

  /** Shutdown: kill every shell so none outlives the workbench. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweeper);
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch (err) {
        log.error("terminal shutdown cleanup failed", err);
      }
    }
    this.#closeListeners.clear();
    for (const term of this.#terms.values()) term.pty.kill();
  }
}

/** The upgrade seam: `/api/terminal?cwd=…` behind the same password boundary
 *  as every route. SameSite=Lax already withholds the cookie cross-site; the
 *  Origin check is the explicit copy of that fact. */
export function attachTerminal(
  server: Server,
  auth: AuthStore,
  opts: HubOptions & { heartbeatMs?: number } = {},
): TerminalHub {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const hub = new TerminalHub(opts);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const alive = new WeakSet<TermSocket>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN || !alive.delete(client)) client.terminate();
      else client.ping(); // browsers and proxies both see traffic
    }
  }, heartbeatMs);
  heartbeat.unref();
  hub.onClose(() => {
    clearInterval(heartbeat);
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  server.once("close", () => hub.close());
  wss.on("error", (err) => log.error("terminal WebSocket server failed", err));
  // A shell outlives the request that opened it, so revocation has to reach it
  // here: the session that opened this socket was signed out (or every session
  // was, by a password change), and the terminal goes with it.
  const sessionOf = new WeakMap<TermSocket, string>();
  const revoked = new WeakSet<TermSocket>();
  auth.onRevoke((id) => {
    for (const client of wss.clients) {
      if (id !== ALL && sessionOf.get(client) !== id) continue;
      revoked.add(client);
      client.close(1008, "signed out");
    }
  });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      log.warn(`refused malformed terminal upgrade target: ${req.url ?? ""}`);
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname !== "/api/terminal") {
      socket.destroy();
      return;
    }
    const sessionId = upgradeAuthorized(auth, req);
    if (!sessionId) {
      log.warn("refused terminal upgrade (unauthorized)");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessionOf.set(ws, sessionId);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      // Frames can land while attach() is resolving realpath; hold a bounded
      // handful. Close is registered first so an early disconnect cannot leave
      // a phantom client that prevents the one-hour reap.
      let conn: TermConn | null = null;
      let closed = false;
      let pendingBytes = 0;
      const pending: string[] = [];
      ws.on("close", () => {
        closed = true;
        conn?.detach();
      });
      ws.on("message", (data, binary) => {
        if (closed) return;
        // A frame can already be in flight when the close above goes out.
        if (revoked.has(ws)) {
          closed = true;
          ws.close(1008, "signed out");
          return;
        }
        if (binary) {
          closed = true;
          ws.close(1003, "text frames only");
          return;
        }
        const text = String(data);
        if (conn) conn.message(text);
        else if ((pendingBytes += Buffer.byteLength(text)) <= MAX_FRAME_BYTES) pending.push(text);
        else {
          closed = true;
          ws.close(1009, "too much pending input");
        }
      });
      ws.on("error", (err) => log.warn(`terminal socket error: ${String(err)}`));
      void hub.attach(url.searchParams.get("cwd") ?? "", ws).then((c) => {
        if (!c) return;
        if (closed) {
          c.detach();
          return;
        }
        conn = c;
        for (const text of pending) conn.message(text);
      }).catch((err: unknown) => {
        log.error("terminal attach failed", err);
        if (closed) return;
        control(ws, { t: "error", message: `terminal attach failed: ${String(err)}` });
        ws.close(1011, "attach failed");
      });
    });
  });
  return hub;
}
