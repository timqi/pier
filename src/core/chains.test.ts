import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ChainAmbiguous, ChainArchived, ChainExists, ChainHasOpen, ChainInvalid, Chains } from "./chains.js";

function rig(open: Record<string, number> = {}) {
  // After the migration stamped Main.
  let now = Date.now() + 60_000;
  const chains = new Chains(openDb(":memory:"), (id) => open[id] ?? 0, () => ++now);
  return { chains, open };
}

describe("Chains", () => {
  it("starts with the migration's Main, active and first", () => {
    const { chains } = rig();
    expect(chains.list()).toEqual([expect.objectContaining({ id: "main", name: "Main", archivedAt: null })]);
    expect(chains.first().id).toBe("main");
    expect(chains.get("main")?.name).toBe("Main");
    expect(chains.get("nope")).toBeUndefined();
  });

  it("creates a trimmed name under a short id, unique among active chains in any case", () => {
    const { chains } = rig();
    const design = chains.create("  Design  ");
    expect(design).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), name: "Design", createdAt: expect.any(Number), archivedAt: null });
    expect(() => chains.create("design")).toThrow(ChainExists);
    expect(() => chains.create("design")).toThrow('chain: "design" exists');
    expect(() => chains.create("   ")).toThrow(ChainInvalid);
    expect(() => chains.create("x".repeat(41))).toThrow("chain: name must be 1–40 characters");
    // A `/chain` verb as a name could never be switched to.
    for (const verb of ["new", "Rename", "ARCHIVE"]) expect(() => chains.create(verb)).toThrow(ChainInvalid);
    // Characters, not UTF-16 units.
    expect(chains.create("链".repeat(40)).name).toHaveLength(40);
    expect(chains.list().map((c) => c.name)).toEqual(["Main", "Design", "链".repeat(40)]);
  });

  it("renames by id, keeping its own name free to recase", () => {
    const { chains } = rig();
    const d = chains.create("Design");
    expect(chains.rename(d.id, "design").name).toBe("design");
    expect(() => chains.rename(d.id, "MAIN")).toThrow(ChainExists);
    expect(chains.get(d.id)?.name).toBe("design");
  });

  it("archives only with nothing open unless forced, never the last active chain, and lists archived last", () => {
    const { chains, open } = rig();
    const d = chains.create("Design");
    open[d.id] = 2;
    const refused = (() => { try { chains.archive(d.id); } catch (err) { return err; } })();
    expect(refused).toBeInstanceOf(ChainHasOpen);
    expect((refused as ChainHasOpen).open).toBe(2);
    expect((refused as Error).message).toBe("chain: Design has 2 open — /status first");
    expect(chains.archive(d.id, true).archivedAt).not.toBeNull();
    expect(() => chains.archive("main")).toThrow("chain: Main is the only active chain");
    const later = chains.create("Later");
    expect(chains.list().map((c) => c.id)).toEqual(["main", later.id, d.id]);
    chains.archive("main");
    expect(chains.first().id).toBe(later.id);
  });

  it("unarchives unless an active chain took its name meanwhile", () => {
    const { chains } = rig();
    const d = chains.create("Design");
    chains.archive(d.id);
    const other = chains.create("design");
    expect(() => chains.unarchive(d.id)).toThrow(ChainExists);
    chains.rename(other.id, "Other");
    expect(chains.unarchive(d.id).archivedAt).toBeNull();
  });

  it("resolves the one name holding every word in any case, an exact name first, across archived chains too", () => {
    const { chains } = rig();
    const design = chains.create("Design");
    const desktop = chains.create("Desktop");
    expect(chains.resolve("desi").id).toBe(design.id);
    expect(() => chains.resolve("des")).toThrow(ChainAmbiguous);
    expect(() => chains.resolve("des")).toThrow("/chain des matches Design, Desktop — say more");
    expect(() => chains.resolve("zzz")).toThrow('chain: no chain "zzz"');
    expect(chains.resolve("SIGN").id).toBe(design.id);
    expect(() => chains.resolve("es")).toThrow("/chain es matches Design, Desktop — say more");
    const base = chains.create("Aave on Base");
    expect(chains.resolve("base aave").id).toBe(base.id);
    expect(() => chains.resolve("aave arb")).toThrow('chain: no chain "aave arb"');
    chains.archive(base.id);
    chains.archive(desktop.id);
    expect(chains.resolve("deskt").id).toBe(desktop.id);
    const de = chains.create("De");
    expect(chains.resolve("de").id).toBe(de.id);
    // An archived chain may share an active one's name; the active one is meant.
    chains.archive(de.id);
    const again = chains.create("De");
    expect(chains.resolve("DE").id).toBe(again.id);
  });

  it("words an archived chain's refusal", () => {
    expect(new ChainArchived("Design").message).toBe("chain: Design is archived — unarchive first");
  });
});
