import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ReceiptLedger } from "./receipts.js";

let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "pier-receipts-")), "pier.db");
});

const receipt = (conversationId: string, messageId: string) => ({
  conversationId,
  chatId: conversationId.split("/")[0]!,
  messageId,
});

describe("receipt ledger", () => {
  it("claims a conversation's receipts exactly once", () => {
    const ledger = new ReceiptLedger("telegram", dbPath);
    ledger.add(receipt("-100/7", "1"));
    ledger.add(receipt("-100/7", "2"));
    ledger.add(receipt("-100/8", "3"));
    expect(ledger.take("-100/7").map((r) => r.messageId)).toEqual(["1", "2"]);
    expect(ledger.take("-100/7")).toEqual([]);
    expect(ledger.take("-100/8").map((r) => r.messageId)).toEqual(["3"]);
    ledger.close();
  });

  it("re-marking one message replaces its row instead of duplicating it", () => {
    const ledger = new ReceiptLedger("telegram", dbPath);
    ledger.add(receipt("-100", "1"));
    ledger.add(receipt("-100", "1"));
    expect(ledger.take("-100")).toHaveLength(1);
    ledger.close();
  });

  it("a re-marked message follows the conversation it now belongs to", () => {
    const ledger = new ReceiptLedger("telegram", dbPath);
    ledger.add(receipt("-100", "1"));
    ledger.add({ conversationId: "-100/7", chatId: "-100", messageId: "1" });
    expect(ledger.take("-100")).toEqual([]);
    expect(ledger.take("-100/7")).toHaveLength(1);
    ledger.close();
  });

  it("takeStale(0) claims everything — the startup sweep", () => {
    const ledger = new ReceiptLedger("telegram", dbPath);
    ledger.add(receipt("-100", "1"));
    ledger.add(receipt("-200", "2"));
    expect(ledger.takeStale(0)).toHaveLength(2);
    expect(ledger.takeStale(0)).toEqual([]);
    ledger.close();
  });

  it("leaves receipts younger than the age bound alone", () => {
    const ledger = new ReceiptLedger("telegram", dbPath);
    ledger.add(receipt("-100", "1"));
    expect(ledger.takeStale(60_000)).toEqual([]);
    expect(ledger.takeStale(60_000, Date.now() + 61_000)).toHaveLength(1);
    ledger.close();
  });

  it("survives a restart and keeps platforms apart", () => {
    const first = new ReceiptLedger("telegram", dbPath);
    first.add(receipt("-100", "1"));
    first.close();
    expect(new ReceiptLedger("slack", dbPath).takeStale(0)).toEqual([]);
    const second = new ReceiptLedger("telegram", dbPath);
    expect(second.takeStale(0)).toHaveLength(1);
    second.close();
  });
});
