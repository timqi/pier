// `pier search`: the agent's recall by message — the `/search` route's host,
// which puts the conversation's messages ahead of every other session's and
// names each hit's place, and the verb's argv; root keeps only the dispatch, as
// for `pier task` and `pier web`. The host validates the params and its text
// reaches the shell verbatim (08 §Failure lines).

import { parseArgs } from "node:util";
import { readableTitle } from "./identity.js";
import type { AgentFactory, SearchHit, SearchScope } from "./types.js";

type Hit = SearchHit & { place: string; pier: boolean };

/** `POST /search` as cli.ts performs it. */
export type SearchPost = (params: Record<string, unknown>) => Promise<{ status: number; body: { result?: { hits: Hit[] }; error?: string } }>;

export interface SearchCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const USAGE = "usage: pier search <q...> [--in pier|<sessionId>] [--since <N>h|<N>d|YYYY-MM-DD] [--role user|assistant] [--limit N] [--json]";
const ROLES = ["user", "assistant"];
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
// sv-SE spells local time as YYYY-MM-DD HH:MM.
const when = (at: number): string => new Date(at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

const processIo: SearchCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** `/search`'s params to hits: Pier's (every `chain()` member) first, then, for
 *  what the limit still allows, every other session's; each named by its place —
 *  `Pier`, or its session's title as it is now, its id when gone from disk. */
export const searchMessages = (factory: Pick<AgentFactory, "search" | "find">, chain: () => string[]) => async (params: unknown): Promise<{ hits: Hit[] }> => {
  const { q, limit = 10, since, role, in: where } = (params ?? {}) as Record<string, unknown>;
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) throw new Error("q must be non-empty words to search for");
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("limit must be an integer from 1 to 50");
  if (since !== undefined && (!Number.isInteger(since) || (since as number) < 0)) throw new Error("since must be a non-negative integer of ms");
  if (role !== undefined && !ROLES.includes(role as string)) throw new Error("role must be user or assistant");
  if (where !== undefined && (typeof where !== "string" || !where)) throw new Error("in must be pier or a session id");
  const scope: SearchScope = { limit: limit as number, ...(since === undefined ? {} : { since: since as number }), ...(role === undefined ? {} : { role: role as SearchScope["role"] }) };
  const members = chain();
  let hits: SearchHit[];
  if (where === "pier") hits = await factory.search(query, { ...scope, sessions: members });
  else if (where !== undefined) hits = await factory.search(query, { ...scope, sessions: [where as string] });
  else {
    hits = members.length ? await factory.search(query, { ...scope, sessions: members }) : [];
    if (hits.length < scope.limit) hits = [...hits, ...await factory.search(query, { ...scope, limit: scope.limit - hits.length, exclude: members })];
  }
  const pier = new Set(members);
  return {
    hits: await Promise.all(hits.map(async (hit) => pier.has(hit.sessionId)
      ? { ...hit, place: "Pier", pier: true }
      : { ...hit, place: readableTitle((await factory.find(hit.sessionId))?.title) ?? hit.sessionId, pier: false })),
  };
};

/** `--since` to ms: hours or days back from now, or a date's local midnight. */
function sinceMs(value: string): number | undefined {
  const back = /^(\d+)([hd])$/.exec(value);
  if (back) return Date.now() - Number(back[1]) * (back[2] === "h" ? 3_600_000 : 86_400_000);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!date) return undefined;
  const [y, m, d] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
  const at = new Date(y, m, d);
  // Date rolls 2025-02-30 into March; a day that does not exist is refused.
  return at.getFullYear() === y && at.getMonth() === m && at.getDate() === d ? at.getTime() : undefined;
}

/** One line per hit, or the answer's object with `--json`. */
export async function runSearchCli(argv: string[], post: SearchPost, io: SearchCliIo = processIo): Promise<number> {
  const usage = (why: string): number => {
    io.stderr(`search: ${why}\n${USAGE}`);
    return 2;
  };
  let v: { in?: string[]; since?: string; role?: string; limit?: string; json?: boolean } = {};
  let words: string[] = [];
  try {
    ({ values: v, positionals: words } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      in: { type: "string", multiple: true }, since: { type: "string" }, role: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" },
    } }));
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  if (!words.length) return usage("say what to search for");
  if ((v.in?.length ?? 0) > 1) return usage("--in takes one place");
  const since = v.since === undefined ? undefined : sinceMs(v.since);
  if (v.since !== undefined && since === undefined) return usage("--since takes <N>h, <N>d or YYYY-MM-DD");
  if (v.role !== undefined && !ROLES.includes(v.role)) return usage("--role takes user or assistant");
  const { status, body } = await post({
    q: words.join(" "),
    ...(v.limit === undefined ? {} : { limit: Number(v.limit) }),
    ...(since === undefined ? {} : { since }),
    ...(v.role === undefined ? {} : { role: v.role }),
    ...(v.in === undefined ? {} : { in: v.in[0] }),
  });
  if (status !== 200 || !body.result) {
    io.stderr(`search: ${body.error ?? `socket answered ${String(status)}`}`);
    return 1;
  }
  const { hits } = body.result;
  if (v.json) io.stdout(JSON.stringify(body.result));
  else if (!hits.length) io.stdout("no hits");
  else for (const hit of hits) io.stdout(`${when(hit.at)} · ${flat(hit.place)} · ${hit.role}: ${flat(hit.text)}`);
  return 0;
}
