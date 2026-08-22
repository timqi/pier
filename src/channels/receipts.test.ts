import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ReceiptLedger } from "./receipts.js";

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
