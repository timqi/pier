// The local socket the `pier` CLI reaches the running instance through: one
// route per verb the CLI has, the socket's permission bits as the whole auth.
// Not a workbench route — that server sits behind a proxy at a public
// hostname — so plaintext crosses this socket into a local process of Pier's
// user and nowhere else.

import { chmodSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "./log.js";
import { PIER_SOCK } from "./paths.js";
import { isVaultName, UnknownSecret, VaultLocked, type Vault } from "./vault.js";

const log = logger("socket");

/** Generous for a task draft; anything past it is not a client of ours. */
const MAX_BODY = 64 * 1024;

export interface SocketHosts {
  vault: Pick<Vault, "resolve">;
  /** The Console deep link for a name nobody has filed yet: the agent's error
   *  carries it, so the operator's path is one click and one paste. */
  fileUrl: (name: string) => string;
  /** The task tool, exactly as a session's tool call reaches it. */
  task: (params: unknown, callerSessionId: string) => Promise<unknown>;
  /** Identity, not authentication: the 0600 bits are the boundary, this is the
   *  audit key. A session Pier can locate is known; nothing else is. */
  knows: (sessionId: string) => Promise<boolean>;
}

type Answer = (status: number, body: Record<string, unknown>) => void;

const ROUTES: Record<string, (hosts: SocketHosts, body: Record<string, unknown>, sessionId: string, answer: Answer) => Promise<void>> = {
  async "/resolve"({ vault, fileUrl }, { names }, sessionId, answer) {
    if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && isVaultName(n))) {
      return answer(400, { error: "names must be a non-empty list of vault names" });
    }
    try {
      answer(200, { values: vault.resolve(names as string[], `session ${sessionId}`) });
    } catch (err) {
      if (err instanceof UnknownSecret) return answer(404, { error: err.message, file: fileUrl(err.secret) });
      if (err instanceof VaultLocked) return answer(423, { error: err.message });
      log.error(`resolve ${names.join(",")} failed`, err);
      answer(500, { error: String(err) });
    }
  },
  // 422, not 400: the request was well-formed; what the tool refused is the
  // caller's to read, the same text a tool call would have been handed.
  async "/task"({ task }, { params }, sessionId, answer) {
    try {
      answer(200, { result: await task(params, sessionId) });
    } catch (err) {
      answer(422, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export function servePier(hosts: SocketHosts, path: string = PIER_SOCK): Server {
  const server = createServer((req, res) => void handle(hosts, req, res).catch((err: unknown) => {
    log.error(`${req.method ?? "?"} ${req.url ?? "?"} failed`, err);
    if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(err) }));
  }));
  // A crash leaves the old socket file behind, and listen() on it is EADDRINUSE.
  rmSync(path, { force: true });
  // bind() runs inside listen(): the umask covers the instant the file exists
  // with default bits; the chmod sets the exact mode once it is bound. A bind
  // that failed reports through the error event and left no file to chmod.
  const umask = process.umask(0o077);
  try {
    server.listen(path, () => log.info(`cli socket at ${path}`));
  } finally {
    process.umask(umask);
  }
  if (server.listening) chmodSync(path, 0o600);
  server.on("error", (err) => log.error(`cli socket ${path} failed`, err));
  process.once("exit", () => rmSync(path, { force: true }));
  return server;
}

async function handle(hosts: SocketHosts, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const answer: Answer = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const route = req.method === "POST" ? ROUTES[req.url ?? ""] : undefined;
  if (!route) return answer(404, { error: `POST ${Object.keys(ROUTES).join(" | ")} only` });
  let raw = "";
  for await (const chunk of req) {
    raw += (chunk as Buffer).toString();
    if (raw.length > MAX_BODY) return void req.destroy();
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return answer(400, { error: "body must be a JSON object" });
  }
  const { sessionId, ...fields } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof sessionId !== "string" || !sessionId) return answer(400, { error: "PIER_SESSION_ID is required" });
  if (!(await hosts.knows(sessionId))) return answer(403, { error: `${sessionId} is not a session of this Pier` });
  await route(hosts, fields, sessionId, answer);
}
