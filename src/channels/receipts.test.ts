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

describe("receipt ledger", () => {
  it("claims a conversation's receipts exactly once", () => {
    const ledger = new ReceiptLedger("telegram", db);
    ledger.add(receipt("-100/7", "1"));
    ledger.add(receipt("-100/7", "2"));
    ledger.add(receipt("-100/8", "3"));
    expect(ledger.take("-100/7").map((r) => r.messageId)).toEqual(["1", "2"]);
    expect(ledger.take("-100/7")).toEqual([]);
    expect(ledger.take("-100/8").map((r) => r.messageId)).toEqual(["3"]);
  });

  it("re-marking one message replaces its row instead of duplicating it", () => {
    const ledger = new ReceiptLedger("telegram", db);
    ledger.add(receipt("-100", "1"));
    ledger.add(receipt("-100", "1"));
    expect(ledger.take("-100")).toHaveLength(1);
  });

  it("a re-marked message follows the conversation it now belongs to", () => {
    const ledger = new ReceiptLedger("telegram", db);
    ledger.add(receipt("-100", "1"));
    ledger.add({ conversationId: "-100/7", chatId: "-100", messageId: "1" });
    expect(ledger.take("-100")).toEqual([]);
    expect(ledger.take("-100/7")).toHaveLength(1);
  });

  it("takeStale(0) claims everything — the startup sweep", () => {
    const ledger = new ReceiptLedger("telegram", db);
    ledger.add(receipt("-100", "1"));
    ledger.add(receipt("-200", "2"));
    expect(ledger.takeStale(0)).toHaveLength(2);
    expect(ledger.takeStale(0)).toEqual([]);
  });

  it("leaves receipts younger than the age bound alone", () => {
    const ledger = new ReceiptLedger("telegram", db);
    ledger.add(receipt("-100", "1"));
    expect(ledger.takeStale(60_000)).toEqual([]);
    expect(ledger.takeStale(60_000, Date.now() + 61_000)).toHaveLength(1);
  });

  it("sweeps once and then throttles, but never the startup sweep", async () => {
    // Adapters ask on every inbound event; the books change on the scale of
    // staleMs, so all but the first ask inside the window is a no-op.
    const ledger = new ReceiptLedger("telegram", db);
    const cleared: string[] = [];
    const receipts = new Receipts(
      { setReaction: (_chatId, messageId) => (cleared.push(messageId), Promise.resolve()) },
      ledger,
      () => {},
      "👀",
      0,
    );
    ledger.add(receipt("-100", "1"));
    await receipts.sweep();
    expect(cleared).toEqual(["1"]);
    ledger.add(receipt("-100", "2"));
    await receipts.sweep();
    expect(cleared).toEqual(["1"]);
    // `all` takes everything on the books, so it is never skipped.
    await receipts.sweep(true);
    expect(cleared).toEqual(["1", "2"]);
  });

  it("waits for every apply before clearing receipts in booking order", async () => {
    const ledger = new ReceiptLedger("telegram", db);
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
    receipts.mark("-100", "-100", "1");
    receipts.mark("-100", "-100", "2");
    const settled = receipts.settle("-100");
    await Promise.resolve();
    expect(calls).toEqual(["apply:1", "apply:2"]);
    release();
    await settled;
    expect(calls).toEqual(["apply:1", "apply:2", "clear:1", "clear:2"]);
  });

  it("survives a restart and keeps platforms apart", () => {
    const first = new ReceiptLedger("telegram", db);
    first.add(receipt("-100", "1"));
    // A restart: the connection is gone, the file is not.
    db.close();
    db = openDb(dbPath);
    expect(new ReceiptLedger("slack", db).takeStale(0)).toEqual([]);
    expect(new ReceiptLedger("telegram", db).takeStale(0)).toHaveLength(1);
  });
});
