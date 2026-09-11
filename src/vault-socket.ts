// The Unix socket `pier vault run` reaches the vault through: one route, the
// socket's permission bits as the whole auth. Not a workbench route — that
// server sits behind a proxy at a public hostname — so plaintext crosses this
// socket into a local process of Pier's user and nowhere else.

import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { logger } from "./log.js";
import { VAULT_SOCK } from "./paths.js";
import { isVaultName, UnknownSecret, VaultLocked, type Vault } from "./vault.js";

const log = logger("vault");

/** Generous for a list of names; anything past it is not a client of ours. */
const MAX_BODY = 64 * 1024;

/** `fileUrl` is the Console deep link for a name nobody has filed yet: the
 *  agent's error carries it, so the operator's path is one click and one paste. */
export function serveVault(
  vault: Pick<Vault, "resolve">,
  fileUrl: (name: string) => string,
  path: string = VAULT_SOCK,
): Server {
  const server = createServer((req, res) => {
    const answer = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/resolve") return answer(404, { error: "POST /resolve only" });
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return answer(400, { error: "body must be JSON {names: string[]}" });
      }
      const { names, pid } = (typeof body === "object" && body !== null ? body : {}) as {
        names?: unknown;
        pid?: unknown;
      };
      if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && isVaultName(n))) {
        return answer(400, { error: "names must be a non-empty list of vault names" });
      }
      try {
        answer(200, { values: vault.resolve(names as string[], `pid ${typeof pid === "number" ? String(pid) : "?"}`) });
      } catch (err) {
        if (err instanceof UnknownSecret) return answer(404, { error: err.message, file: fileUrl(err.secret) });
        if (err instanceof VaultLocked) return answer(423, { error: err.message });
        log.error(`resolve ${names.join(",")} failed`, err);
        answer(500, { error: String(err) });
      }
    });
  });
  // A crash leaves the old socket file behind, and listen() on it is EADDRINUSE.
  rmSync(path, { force: true });
  // bind() runs inside listen(): the umask covers the instant the file exists
  // with default bits; the chmod sets the exact mode once it is bound. A bind
  // that failed reports through the error event and left no file to chmod.
  const umask = process.umask(0o077);
  try {
    server.listen(path, () => log.info(`vault socket at ${path}`));
  } finally {
    process.umask(umask);
  }
  if (server.listening) chmodSync(path, 0o600);
  server.on("error", (err) => log.error(`vault socket ${path} failed`, err));
  process.once("exit", () => rmSync(path, { force: true }));
  return server;
}
