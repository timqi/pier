// `pier search`: the agent's recall by message — the `/search` route's host,
// which puts the caller's chain's messages ahead of every other session's and
// names each hit's place, and the verb's argv; root keeps only the dispatch, as
// for `pier task` and `pier web`. The host validates the params and its text
// reaches the shell verbatim (08 §Failure lines).

import { parseArgs } from "node:util";
import { readableTitle } from "./identity.js";
import type { Chains, ChainRow } from "./chains.js";
import type { AgentFactory, SearchHit, SearchScope } from "./types.js";

type Hit = SearchHit & { place: string; pier: boolean; chain?: { id: string; name: string } };

/** The chain register and each chain's members, newest first: what `/search` reads of core/chain.ts. */
export interface SearchChains {
  chains: Pick<Chains, "list" | "resolve">;
  members: (chainId: string) => string[];
}

/** `POST /search` as cli.ts performs it. */
export type SearchPost = (params: Record<string, unknown>) => Promise<{ status: number; body: { result?: { hits: Hit[] }; error?: string } }>;

export interface SearchCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const USAGE = "usage: pier search <q...> [--in main|chain:<name>|<sessionId>] [--since <N>h|<N>d|YYYY-MM-DD] [--role user|assistant] [--limit N] [--json]\n"
  + "       pier search --around \"YYYY-MM-DD HH:MM\" [--in main|chain:<name>|<sessionId>] [--limit N] [--json]";
const ROLES = ["user", "assistant"];
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
// sv-SE spells local time as YYYY-MM-DD HH:MM.
const when = (at: number): string => new Date(at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

const processIo: SearchCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** `/search`'s params to hits: the caller's chain first, then every other
 *  chain's, then, for what the limit still allows, every other session's; each
 *  named by its place — its chain's name, or its session's title as it is now,
 *  its id when gone from disk. `in` narrows to every chain (`main`, or its older
 *  spelling `pier`), one chain (`chain:<name>`, a unique prefix) or one session.
 *  `around` replays one place instead: the caller's chain, every chain when the
 *  caller is in none, unless `in` names one. */
export const searchMessages = (factory: Pick<AgentFactory, "search" | "find">, { chains, members }: SearchChains) => async (params: unknown, callerSessionId?: string): Promise<{ hits: Hit[] }> => {
  const { q, limit = 10, since, role, in: where, around } = (params ?? {}) as Record<string, unknown>;
  const query = typeof q === "string" ? q.trim() : "";
  if (around !== undefined) {
    if (!Number.isInteger(around) || (around as number) < 0) throw new Error("around must be a non-negative integer of ms");
    if (query || since !== undefined || role !== undefined) throw new Error("around replays the conversation: no q, since or role beside it");
  } else if (!query) throw new Error("q must be non-empty words to search for");
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("limit must be an integer from 1 to 50");
  if (since !== undefined && (!Number.isInteger(since) || (since as number) < 0)) throw new Error("since must be a non-negative integer of ms");
  if (role !== undefined && !ROLES.includes(role as string)) throw new Error("role must be user or assistant");
  if (where !== undefined && (typeof where !== "string" || !where)) throw new Error("in must be main, chain:<name> or a session id");
  const scope: SearchScope = {
    limit: limit as number,
    ...(since === undefined ? {} : { since: since as number }),
    ...(role === undefined ? {} : { role: role as SearchScope["role"] }),
    ...(around === undefined ? {} : { around: around as number }),
  };
  const groups = chains.list().map((chain) => ({ chain, members: members(chain.id) }));
  const all = groups.flatMap((g) => g.members);
  const caller = groups.find((g) => callerSessionId !== undefined && g.members.includes(callerSessionId));
  const named = typeof where === "string" && where.startsWith("chain:") ? resolveIn(chains, where.slice("chain:".length)) : undefined;
  let hits: SearchHit[];
  if (named) hits = await factory.search(query, { ...scope, sessions: groups.find((g) => g.chain.id === named.id)?.members ?? [] });
  else if (where === "main" || where === "pier") hits = await factory.search(query, { ...scope, sessions: all });
  else if (where !== undefined) hits = await factory.search(query, { ...scope, sessions: [where as string] });
  else if (around !== undefined) hits = await factory.search(query, { ...scope, sessions: caller?.members ?? all });
  else {
    const mine = caller?.members ?? [];
    const others = all.filter((id) => !mine.includes(id));
    hits = [];
    for (const sessions of [mine, others]) {
      if (sessions.length && hits.length < scope.limit) hits = [...hits, ...await factory.search(query, { ...scope, limit: scope.limit - hits.length, sessions })];
    }
    if (hits.length < scope.limit) hits = [...hits, ...await factory.search(query, { ...scope, limit: scope.limit - hits.length, exclude: all })];
  }
  const chainOf = new Map(groups.flatMap((g) => g.members.map((id) => [id, g.chain] as const)));
  return {
    hits: await Promise.all(hits.map(async (hit) => {
      const chain = chainOf.get(hit.sessionId);
      return chain
        ? { ...hit, place: chain.name, pier: true, chain: { id: chain.id, name: chain.name } }
        : { ...hit, place: readableTitle((await factory.find(hit.sessionId))?.title) ?? hit.sessionId, pier: false };
    })),
  };
};

/** `chain:<name>`'s chain; an unknown or ambiguous name is the refusal, worded for `--in`. */
function resolveIn(chains: Pick<Chains, "resolve">, name: string): ChainRow {
  try {
    return chains.resolve(name);
  } catch (err) {
    // The register words its refusals for `/chain`; here the spelling was `chain:<q>`, under the CLI's `search:`.
    throw new Error((err instanceof Error ? err.message : String(err)).replace(/^\/chain /, "chain:").replace(/^chain: /, ""));
  }
}

/** `YYYY-MM-DD HH:MM` local, the time a hit line prints, or a date's local
 *  midnight, to ms. */
function localMs(value: string): number | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(value);
  if (!date) return undefined;
  const parts = [Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(date[4] ?? 0), Number(date[5] ?? 0)] as const;
  const at = new Date(...parts);
  // Date rolls 2025-02-30 into March and 24:00 into the next day; a moment that does not exist is refused.
  return [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()].join() === parts.join() ? at.getTime() : undefined;
}

/** `--since` to ms: hours or days back from now, or a date's local midnight. */
function sinceMs(value: string): number | undefined {
  const back = /^(\d+)([hd])$/.exec(value);
  if (back) return Date.now() - Number(back[1]) * (back[2] === "h" ? 3_600_000 : 86_400_000);
  return value.includes(" ") ? undefined : localMs(value);
}

/** One line per hit, or the answer's object with `--json`. */
export async function runSearchCli(argv: string[], post: SearchPost, io: SearchCliIo = processIo): Promise<number> {
  const usage = (why: string): number => {
    io.stderr(`search: ${why}\n${USAGE}`);
    return 2;
  };
  let v: { in?: string[]; since?: string; role?: string; limit?: string; json?: boolean; around?: string } = {};
  let words: string[] = [];
  try {
    ({ values: v, positionals: words } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      in: { type: "string", multiple: true }, since: { type: "string" }, role: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, around: { type: "string" },
    } }));
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  if (v.around !== undefined && (words.length || v.since !== undefined || v.role !== undefined)) return usage("--around replays the conversation: no words, --since or --role beside it");
  if (!words.length && v.around === undefined) return usage("say what to search for");
  if ((v.in?.length ?? 0) > 1) return usage("--in takes one place");
  const around = v.around === undefined ? undefined : localMs(v.around);
  if (v.around !== undefined && around === undefined) return usage("--around takes YYYY-MM-DD HH:MM or YYYY-MM-DD");
  const since = v.since === undefined ? undefined : sinceMs(v.since);
  if (v.since !== undefined && since === undefined) return usage("--since takes <N>h, <N>d or YYYY-MM-DD");
  if (v.role !== undefined && !ROLES.includes(v.role)) return usage("--role takes user or assistant");
  const { status, body } = await post({
    ...(around === undefined ? { q: words.join(" ") } : { around }),
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
