// The continuous conversation's chains as TaskService sees them, over a fixed
// map of chain id to members, newest first; read at each call, so a test may change it.

import type { ChainRow } from "../core/chains.js";
import type { TaskChain } from "./service.js";

export function fakeChains(members: Record<string, string[]> = {}): { continuous: TaskChain; chains: { list(): ChainRow[] } } {
  const ids = (): string[] => (Object.keys(members).length ? Object.keys(members) : ["main"]);
  const chainOf = (id: string) => {
    const chainId = ids().find((c) => members[c]?.includes(id));
    return chainId === undefined ? undefined : { chainId, members: members[chainId]! };
  };
  const continuous: TaskChain = {
    members: (chainId) => (members[chainId] ?? []).map((sessionId) => ({ sessionId, startedAt: 1, reason: "first" as const })),
    chainOf,
    headOf: (id) => chainOf(id)?.members[0] ?? id,
    firstHead: () => members[ids()[0]!]?.[0] ?? null,
    heads: () => ids().flatMap((chainId) => (members[chainId]?.[0] ? [{ chainId, sessionId: members[chainId][0] }] : [])),
    isHead: (id) => chainOf(id)?.members[0] === id,
  };
  const chains = { list: () => ids().map((id) => ({ id, name: id === "main" ? "Main" : id, createdAt: 0, archivedAt: null })) };
  return { continuous, chains };
}
