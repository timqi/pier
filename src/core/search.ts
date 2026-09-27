// `pier search`: the `/search` route's host and the verb's argv, on the search
// seam core declares (`AgentFactory.search`); root keeps only the dispatch, as
// for `pier task` and `pier web`. Argv shape is checked here, the host validates
// the params, and its text reaches the shell verbatim (08 §Failure lines).

import { parseArgs } from "node:util";
import { readableTitle } from "./identity.js";
import type { AgentFactory, SearchHit } from "./types.js";

type Hit = SearchHit & { title: string };

/** `POST /search` as cli.ts performs it. */
export type SearchPost = (params: Record<string, unknown>) => Promise<{ status: number; body: { result?: { hits: Hit[] }; error?: string } }>;

export interface SearchCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const USAGE = "usage: pier search <q...> [--limit N] [--json]";
// The match marks are the palette's to paint; a line is one line.
const flat = (text: string): string => text.replaceAll("\u0001", "").replaceAll("\u0002", "").replace(/\s+/g, " ").trim();
// sv-SE spells local time as YYYY-MM-DD HH:MM.
const when = (at: number): string => new Date(at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

const processIo: SearchCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** `/search`'s params to hits, each titled with its session's name as it is
 *  now; a session gone from disk is named by its id. */
export const searchSessions = (factory: Pick<AgentFactory, "search" | "find">) => async (params: unknown): Promise<{ hits: Hit[] }> => {
  const { q, limit = 20 } = (params ?? {}) as { q?: unknown; limit?: unknown };
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) throw new Error("q must be non-empty words to search for");
  if (!Number.isInteger(limit)) throw new Error("limit must be an integer");
  const hits = await factory.search(query, Math.min(50, Math.max(1, limit as number)));
  return {
    hits: await Promise.all(hits.map(async (hit) =>
      ({ ...hit, title: readableTitle((await factory.find(hit.sessionId))?.title) ?? hit.sessionId }))),
  };
};

/** One line per hit, or the answer's object with `--json`. */
export async function runSearchCli(argv: string[], post: SearchPost, io: SearchCliIo = processIo): Promise<number> {
  let v: { limit?: string; json?: boolean } = {};
  let words: string[] = [];
  try {
    ({ values: v, positionals: words } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { limit: { type: "string" }, json: { type: "boolean" } } }));
  } catch (err) {
    io.stderr(`search: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (!words.length) {
    io.stderr(`search: say what to search for\n${USAGE}`);
    return 2;
  }
  const { status, body } = await post({ q: words.join(" "), ...(v.limit === undefined ? {} : { limit: Number(v.limit) }) });
  if (status !== 200 || !body.result) {
    io.stderr(`search: ${body.error ?? `socket answered ${String(status)}`}`);
    return 1;
  }
  const { hits } = body.result;
  if (v.json) io.stdout(JSON.stringify(body.result));
  else if (!hits.length) io.stdout("no hits");
  else for (const hit of hits) io.stdout(`${hit.sessionId} · ${flat(hit.title)} · ${hit.role} · ${when(hit.at)}: ${flat(hit.snippet)}`);
  return 0;
}
