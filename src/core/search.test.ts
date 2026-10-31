// The `/search` host: the scope it refuses, the passes that put the caller's
// chain first and every chain before other sessions, and the place each hit is named by.

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { Chains } from "./chains.js";
import { searchMessages, type SearchChains } from "./search.js";
import type { SearchHit, SearchScope } from "./types.js";

const hit = (sessionId: string, at: number): SearchHit => ({ sessionId, role: "user", at, text: `said in ${sessionId}` });

/** A factory whose index holds `rows`; `w1` is titled, `gone` no longer on disk. */
function factory(rows: SearchHit[]) {
  const scopes: SearchScope[] = [];
  return {
    scopes,
    search: async (_query: string, scope: SearchScope) => {
      scopes.push(scope);
      return rows
        .filter((row) => (scope.sessions ? scope.sessions.includes(row.sessionId) : !scope.exclude?.includes(row.sessionId)))
        .slice(0, scope.limit);
    },
    find: async (id: string) => (id === "w1" ? { id, cwd: "/", createdAt: 0, title: "Fix the parser" } : undefined),
  };
}

const rows = [hit("w1", 5), hit("p2", 4), hit("gone", 3), hit("p1", 2), hit("w1", 1)];

/** The migration's `Main` holding `main`, newest first; `more` adds chains by name. */
function chains(main: string[], more: Record<string, string[]> = {}): SearchChains {
  const register = new Chains(openDb(":memory:"), () => 0);
  const members = new Map([["main", main]]);
  for (const [name, ids] of Object.entries(more)) members.set(register.create(name).id, ids);
  return { chains: register, members: (id) => members.get(id) ?? [] };
}

describe("searchMessages", () => {
  it("answers the chain's messages first, then the rest for what the limit still allows", async () => {
    const f = factory(rows);
    const { hits } = await searchMessages(f, chains(["p2", "p1"]))({ q: "said", limit: 3, role: "user", since: 0 });
    expect(hits.map((h) => [h.sessionId, h.place, h.pier])).toEqual([["p2", "Main", true], ["p1", "Main", true], ["w1", "Fix the parser", false]]);
    expect(f.scopes).toEqual([
      { limit: 3, role: "user", since: 0, sessions: ["p2", "p1"] },
      { limit: 1, role: "user", since: 0, exclude: ["p2", "p1"] },
    ]);
  });

  it("skips the second pass when the chain's alone fills the limit", async () => {
    const f = factory(rows);
    expect((await searchMessages(f, chains(["p2", "p1"]))({ q: "said", limit: 2 })).hits).toHaveLength(2);
    expect(f.scopes).toHaveLength(1);
  });

  it("runs one pass over every session when the chain is empty, a gone session named by its id", async () => {
    const f = factory(rows);
    const { hits } = await searchMessages(f, chains([]))({ q: "said" });
    expect(hits.map((h) => h.place)).toEqual(["Fix the parser", "p2", "gone", "p1", "Fix the parser"]);
    expect(f.scopes).toEqual([{ limit: 10, exclude: [] }]);
  });

  it("searches only the conversation with `in: main` (`pier` its alias), only one session with an id", async () => {
    const f = factory(rows);
    const main = await searchMessages(f, chains(["p1"]))({ q: "said", in: "main" });
    expect(main.hits.map((h) => h.sessionId)).toEqual(["p1"]);
    expect((await searchMessages(f, chains(["p1"]))({ q: "said", in: "pier" })).hits.map((h) => h.sessionId)).toEqual(["p1"]);
    const one = await searchMessages(f, chains(["p1"]))({ q: "said", in: "w1" });
    expect(one.hits.map((h) => [h.sessionId, h.at])).toEqual([["w1", 5], ["w1", 1]]);
    // A chain member asked for by id is still named by its chain.
    expect((await searchMessages(f, chains(["p1"]))({ q: "said", in: "p1" })).hits[0]).toMatchObject({ place: "Main", pier: true });
    expect(f.scopes.map((s) => s.sessions)).toEqual([["p1"], ["p1"], ["w1"], ["p1"]]);
  });

  it("replays the conversation around a time in one pass, or one session by id", async () => {
    const f = factory(rows);
    const main = await searchMessages(f, chains(["p2", "p1"]))({ around: 3 });
    expect(main.hits.map((h) => [h.sessionId, h.place])).toEqual([["p2", "Main"], ["p1", "Main"]]);
    expect((await searchMessages(f, chains(["p2", "p1"]))({ around: 3, in: "w1", limit: 2 })).hits.map((h) => h.place)).toEqual(["Fix the parser", "Fix the parser"]);
    expect(f.scopes).toEqual([{ limit: 10, around: 3, sessions: ["p2", "p1"] }, { limit: 2, around: 3, sessions: ["w1"] }]);
    // An empty chain replays nothing rather than every session.
    expect((await searchMessages(f, chains([]))({ around: 3 })).hits).toEqual([]);
    expect(f.scopes[2]).toEqual({ limit: 10, around: 3, sessions: [] });
  });

  it("answers the caller's chain first, then every other chain's, then the rest, each hit named by its chain", async () => {
    const f = factory(rows);
    const c = chains(["p2"], { Design: ["p1"] });
    const design = c.chains.list().find((x) => x.name === "Design")!;
    const { hits } = await searchMessages(f, c)({ q: "said", limit: 3 }, "p1");
    expect(hits.map((h) => [h.sessionId, h.place, h.chain?.name])).toEqual([["p1", "Design", "Design"], ["p2", "Main", "Main"], ["w1", "Fix the parser", undefined]]);
    expect(hits[0]!.chain).toEqual({ id: design.id, name: "Design" });
    expect(f.scopes).toEqual([
      { limit: 3, sessions: ["p1"] },
      { limit: 2, sessions: ["p2"] },
      { limit: 1, exclude: ["p2", "p1"] },
    ]);
    // A caller in no chain starts at every chain's, as one pass.
    f.scopes.length = 0;
    await searchMessages(f, c)({ q: "said", limit: 3 }, "w1");
    expect(f.scopes[0]).toEqual({ limit: 3, sessions: ["p2", "p1"] });
  });

  it("narrows to one chain with `in: chain:<name>`, a unique prefix in any case, and `main` to every chain", async () => {
    const f = factory(rows);
    const c = chains(["p2"], { Design: ["p1"], Desktop: ["gone"] });
    expect((await searchMessages(f, c)({ q: "said", in: "chain:desi" }, "p2")).hits.map((h) => [h.sessionId, h.place])).toEqual([["p1", "Design"]]);
    expect((await searchMessages(f, c)({ q: "said", in: "main" })).hits.map((h) => h.place)).toEqual(["Main", "Desktop", "Design"]);
    expect((await searchMessages(f, c)({ around: 3, in: "chain:Main" }, "p1")).hits.map((h) => h.sessionId)).toEqual(["p2"]);
    // `around` without `in` replays the caller's own chain.
    expect((await searchMessages(f, c)({ around: 3 }, "p1")).hits.map((h) => h.sessionId)).toEqual(["p1"]);
  });

  it.each([
    ["chain:de", "chain:de matches Design, Desktop — say more"],
    ["chain:nope", 'no chain "nope"'],
    ["chain:", 'no chain ""'],
  ])("refuses `in: %s` in one line before searching", async (where, error) => {
    const f = factory(rows);
    await expect(searchMessages(f, chains([], { Design: [], Desktop: [] }))({ q: "x", in: where })).rejects.toMatchObject({ message: error });
    expect(f.scopes).toHaveLength(0);
  });

  it.each([
    [{ q: "  " }, "q must be non-empty words to search for"],
    [{ q: 3 }, "q must be non-empty words to search for"],
    [{ q: "x", limit: 0 }, "limit must be an integer from 1 to 50"],
    [{ q: "x", limit: 51 }, "limit must be an integer from 1 to 50"],
    [{ q: "x", limit: 2.5 }, "limit must be an integer from 1 to 50"],
    [{ q: "x", limit: null }, "limit must be an integer from 1 to 50"],
    [{ q: "x", since: -1 }, "since must be a non-negative integer of ms"],
    [{ q: "x", since: "7d" }, "since must be a non-negative integer of ms"],
    [{ q: "x", role: "tool" }, "role must be user or assistant"],
    [{ q: "x", in: "" }, "in must be main, chain:<name> or a session id"],
    [{ q: "x", in: ["main", "s1"] }, "in must be main, chain:<name> or a session id"],
    [{ around: -1 }, "around must be a non-negative integer of ms"],
    [{ around: "2025-10-19 14:32" }, "around must be a non-negative integer of ms"],
    [{ around: 3, q: "x" }, "around replays the conversation: no q, since or role beside it"],
    [{ around: 3, since: 0 }, "around replays the conversation: no q, since or role beside it"],
    [{ around: 3, role: "user" }, "around replays the conversation: no q, since or role beside it"],
    [{ around: 3, limit: 0 }, "limit must be an integer from 1 to 50"],
  ])("refuses %j before searching", async (params, error) => {
    const f = factory(rows);
    await expect(searchMessages(f, chains([]))(params)).rejects.toThrow(error);
    expect(f.scopes).toHaveLength(0);
  });
});
