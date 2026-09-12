import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ReceiptLedger, Receipts } from "./receipts.js";

let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "pier-receipts-")), "pier.db");
  db = openDb(dbPath);
});

afterEach(() => db.close());

const receipt = (conversationId: string, messageId: string) => ({
  conversationId,
  chatId: conversationId.split("/")[0]!,
  messageId,
});

/** A ledger and a `Receipts` over it whose platform double records only the
 *  messages it cleared — which receipt came off is what settling is about. */
const recording = () => {
  const ledger = new ReceiptLedger("slack", db);
  const cleared: string[] = [];
  const receipts = new Receipts(
    {
      setReaction: (_chatId, messageId, emoji) => {
        if (!emoji) cleared.push(messageId);
        return Promise.resolve();
      },
    },
    ledger,
    () => {},
    "eyes",
    60_000,
  );
  return { receipts, cleared };
};

describe("receipt ledger", () => {
  it("claims a conversation's receipts exactly once", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100/7", "1"));
    ledger.add(receipt("C100/7", "2"));
    ledger.add(receipt("C100/8", "3"));
    expect(ledger.take("C100/7").map((r) => r.messageId)).toEqual(["1", "2"]);
    expect(ledger.take("C100/7")).toEqual([]);
    expect(ledger.take("C100/8").map((r) => r.messageId)).toEqual(["3"]);
  });

  it("re-marking one message replaces its row instead of duplicating it", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100", "1"));
    ledger.add(receipt("C100", "1"));
    expect(ledger.take("C100")).toHaveLength(1);
  });

  it("a re-marked message follows the conversation it now belongs to", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100", "1"));
    ledger.add({ conversationId: "C100/7", chatId: "C100", messageId: "1" });
    expect(ledger.take("C100")).toEqual([]);
    expect(ledger.take("C100/7")).toHaveLength(1);
  });

  it("takeStale(0) claims everything — the startup sweep", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100", "1"));
    ledger.add(receipt("-200", "2"));
    expect(ledger.takeStale(0)).toHaveLength(2);
    expect(ledger.takeStale(0)).toEqual([]);
  });

  it("leaves receipts younger than the age bound alone", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100", "1"));
    expect(ledger.takeStale(60_000)).toEqual([]);
    expect(ledger.takeStale(60_000, Date.now() + 61_000)).toHaveLength(1);
  });

  it("sweeps once and then throttles, but never the startup sweep", async () => {
    // Adapters ask on every inbound event; the books change on the scale of
    // staleMs, so all but the first ask inside the window is a no-op.
    const ledger = new ReceiptLedger("slack", db);
    const cleared: string[] = [];
    const receipts = new Receipts(
      { setReaction: (_chatId, messageId) => (cleared.push(messageId), Promise.resolve()) },
      ledger,
      () => {},
      "👀",
      0,
    );
    ledger.add(receipt("C100", "1"));
    await receipts.sweep();
    expect(cleared).toEqual(["1"]);
    ledger.add(receipt("C100", "2"));
    await receipts.sweep();
    expect(cleared).toEqual(["1"]);
    // `all` takes everything on the books, so it is never skipped.
    await receipts.sweep(true);
    expect(cleared).toEqual(["1", "2"]);
  });

  it("waits for every apply before clearing receipts in booking order", async () => {
    const ledger = new ReceiptLedger("slack", db);
    const calls: string[] = [];
    let release!: () => void;
    const firstApplied = new Promise<void>((resolve) => { release = resolve; });
    const receipts = new Receipts(
      {
        setReaction: (_chatId, messageId, emoji) => {
          calls.push(`${emoji ? "apply" : "clear"}:${messageId}`);
          return emoji && messageId === "1" ? firstApplied : Promise.resolve();
        },
      },
      ledger,
      () => {},
      "eyes",
      60_000,
    );
    receipts.mark("C100", "C100", "1");
    receipts.mark("C100", "C100", "2");
    const settled = receipts.settle("C100");
    await Promise.resolve();
    expect(calls).toEqual(["apply:1", "apply:2"]);
    release();
    await settled;
    expect(calls).toEqual(["apply:1", "apply:2", "clear:1", "clear:2"]);
  });

  it("settles the ending turn's messages, not the next turn's", async () => {
    // A run ends one turn per answer, so a message queued mid-turn is still
    // owed one and keeps its 👀.
    const { receipts, cleared } = recording();
    receipts.mark("C100", "C100", "asked");
    const started = Date.now() + 1; // the turn picked "asked" up
    await new Promise((r) => setTimeout(r, 5));
    receipts.mark("C100", "C100", "queued"); // arrived while that turn ran
    await receipts.settle("C100", { completedAt: started + 500, durationMs: 500, tokens: 1 });
    expect(cleared).toEqual(["asked"]);
    // The queued message's own turn ends next, and takes its receipt with it.
    await receipts.settle("C100", { completedAt: Date.now() + 10, durationMs: 1, tokens: 1 });
    expect(cleared).toEqual(["asked", "queued"]);
  });

  it("books a system note to the turn that posted it, not to the round trip", async () => {
    // The note goes up *because* a turn started, so posting it lands after
    // that start; booked at `now` it would fall outside the turn's own scope
    // and the reaction would sit there until the stale sweep.
    const { receipts, cleared } = recording();
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 5)); // posting the note
    receipts.mark("C100", "C100", "note", started);
    await receipts.settle("C100", { completedAt: started + 500, durationMs: 500, tokens: 1 });
    expect(cleared).toEqual(["note"]);
  });

  it("clears everything when there is no turn to scope by", async () => {
    // The refusal paths (a conversation id with no thread) have no meta, and
    // the stale sweep is the only other thing that would ever clear these.
    const { receipts, cleared } = recording();
    receipts.mark("C100", "C100", "1");
    receipts.mark("C100", "C100", "2");
    await receipts.settle("C100");
    expect(cleared).toEqual(["1", "2"]);
  });

  it("survives a restart and keeps platforms apart", () => {
    const first = new ReceiptLedger("slack", db);
    first.add(receipt("C100", "1"));
    // A restart: the connection is gone, the file is not.
    db.close();
    db = openDb(dbPath);
    expect(new ReceiptLedger("lark", db).takeStale(0)).toEqual([]);
    expect(new ReceiptLedger("slack", db).takeStale(0)).toHaveLength(1);
  });
});
