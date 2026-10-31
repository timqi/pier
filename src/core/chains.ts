// The chain register: each chain's row and its naming rules — which names are
// valid, unique among the active ones, and what a short spelling resolves to
// (docs/plans/30-multi-chain.md §chain 的生命周期). Heads are core/chain.ts'.

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db.js";

export interface ChainRow { id: string; name: string; createdAt: number; archivedAt: number | null }

export class ChainExists extends Error {}
export class ChainInvalid extends Error {}
export class ChainArchived extends Error {
  constructor(name: string) {
    super(`chain: ${name} is archived — unarchive first`);
  }
}
export class ChainHasOpen extends Error {
  constructor(name: string, readonly open: number) {
    super(`chain: ${name} has ${String(open)} open — /status first`);
  }
}
export class ChainAmbiguous extends Error {}

const NAME_MAX = 40;
/** `/chain <word>`'s verbs: a chain so named could never be switched to. */
const RESERVED = new Set(["new", "rename", "archive"]);

type Row = { id: string; name: string; created_at: number; archived_at: number | null };
const row = (r: Row): ChainRow => ({ id: r.id, name: r.name, createdAt: r.created_at, archivedAt: r.archived_at });

export class Chains {
  constructor(
    private readonly db: DatabaseSync,
    /** The chain's open items: an archive with any asks first. */
    private readonly openCount: (chainId: string) => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Active first by creation, then archived by when they were. */
  list(): ChainRow[] {
    return (this.db.prepare(`SELECT id, name, created_at, archived_at FROM chains
      ORDER BY archived_at IS NOT NULL, coalesce(archived_at, created_at), rowid`).all() as Row[]).map(row);
  }

  get(id: string): ChainRow | undefined {
    const found = this.db.prepare("SELECT id, name, created_at, archived_at FROM chains WHERE id = ?").get(id) as Row | undefined;
    return found && row(found);
  }

  /** Where whatever no chain claims lands; archiving never takes the last active one. */
  first(): ChainRow {
    const found = this.list()[0];
    if (!found || found.archivedAt !== null) throw new Error("chain: no active chain");
    return found;
  }

  create(name: string): ChainRow {
    const valid = this.valid(name);
    const id = randomBytes(4).toString("hex");
    this.db.prepare("INSERT INTO chains(id, name, created_at, archived_at) VALUES (?, ?, ?, NULL)").run(id, valid, this.now());
    return this.get(id)!;
  }

  /** Several writes as one: a refused one leaves the others unwritten. */
  transact<T>(work: () => T): T {
    return transact(this.db, work);
  }

  rename(id: string, name: string): ChainRow {
    const chain = this.must(id);
    const valid = this.valid(name, id);
    this.db.prepare("UPDATE chains SET name = ? WHERE id = ?").run(valid, id);
    return { ...chain, name: valid };
  }

  archive(id: string, force = false): ChainRow {
    const chain = this.must(id);
    if (chain.archivedAt !== null) return chain;
    const open = this.openCount(id);
    if (!force && open > 0) throw new ChainHasOpen(chain.name, open);
    if (this.list().filter((c) => c.archivedAt === null).length <= 1) throw new Error(`chain: ${chain.name} is the only active chain`);
    const at = this.now();
    this.db.prepare("UPDATE chains SET archived_at = ? WHERE id = ?").run(at, id);
    return { ...chain, archivedAt: at };
  }

  unarchive(id: string): ChainRow {
    const chain = this.must(id);
    if (chain.archivedAt === null) return chain;
    this.valid(chain.name, id);
    this.db.prepare("UPDATE chains SET archived_at = NULL WHERE id = ?").run(id);
    return { ...chain, archivedAt: null };
  }

  /** A name, or the one name holding each of the query's words, case-insensitive, among every
   *  chain: the caller decides what an archived one means. An exact name wins over
   *  word matches, an active exact name over an archived one. */
  resolve(query: string): ChainRow {
    const q = query.trim().toLowerCase();
    const all = this.list();
    const exact = all.filter((c) => c.name.toLowerCase() === q);
    const active = exact.filter((c) => c.archivedAt === null);
    const words = q.split(/\s+/);
    const named = active.length ? active : exact.length ? exact : all.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    if (!q || !named.length) throw new Error(`chain: no chain "${query.trim()}"`);
    if (named.length > 1) throw new ChainAmbiguous(`/chain ${query.trim()} matches ${named.map((c) => c.name).join(", ")} — say more`);
    return named[0]!;
  }

  private must(id: string): ChainRow {
    const chain = this.get(id);
    if (!chain) throw new Error(`chain: no chain ${id}`);
    return chain;
  }

  /** Trimmed, 1–40 characters, not a `/chain` verb, and no other active chain's name in any case. */
  private valid(name: string, self?: string): string {
    const trimmed = name.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > NAME_MAX) throw new ChainInvalid(`chain: name must be 1–${String(NAME_MAX)} characters`);
    if (RESERVED.has(trimmed.toLowerCase())) throw new ChainInvalid(`chain: "${trimmed}" is a /chain verb — pick another name`);
    const taken = this.list().some((c) => c.archivedAt === null && c.id !== self && c.name.toLowerCase() === trimmed.toLowerCase());
    if (taken) throw new ChainExists(`chain: "${trimmed}" exists`);
    return trimmed;
  }
}
