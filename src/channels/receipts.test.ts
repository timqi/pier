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
const REACTIONS = { working: "eyes", waiting: "question", done: "white_check_mark" };

const recording = () => {
  const ledger = new ReceiptLedger("slack", db);
  const cleared: string[] = [];
  /** Every platform call, `+name:id` or `-name:id`. */
  const calls: string[] = [];
  const logged: string[] = [];
  const receipts = new Receipts(
    {
      addReaction: (_chatId, messageId, emoji) => {
        calls.push(`+${emoji}:${messageId}`);
        return Promise.resolve();
      },
      removeReaction: (_chatId, messageId, emoji) => {
        calls.push(`-${emoji}:${messageId}`);
        cleared.push(messageId);
        return Promise.resolve();
      },
    },
    ledger,
    (m) => logged.push(m),
    REACTIONS,
    60_000,
  );
  return { receipts, cleared, calls, ledger, logged };
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
    expect(ledger.takeStale(60_000, undefined, Date.now() + 61_000)).toHaveLength(1);
  });

  it("leaves a stale receipt whose conversation is still working", () => {
    const ledger = new ReceiptLedger("slack", db);
    ledger.add(receipt("C100", "1"));
    ledger.add(receipt("C200", "2"));
    const later = Date.now() + 61_000;
    const working = (conversationId: string): boolean => conversationId === "C100";
    expect(ledger.takeStale(60_000, working, later)).toEqual([receipt("C200", "2")]);
    // Only the claimed row left the books; the turn that is still going keeps its 👀.
    expect(ledger.takeStale(60_000, undefined, later)).toEqual([receipt("C100", "1")]);
  });

  it("sweeps once and then throttles, but never the startup sweep", async () => {
    // Adapters ask on every inbound event; the books change on the scale of
    // staleMs, so all but the first ask inside the window is a no-op.
    const ledger = new ReceiptLedger("slack", db);
    const cleared: string[] = [];
    const receipts = new Receipts(
      { addReaction: () => Promise.resolve(), removeReaction: (_chatId, messageId) => (cleared.push(messageId), Promise.resolve()) },
      ledger,
      () => {},
      REACTIONS,
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
        addReaction: (_chatId, messageId) => {
          calls.push(`apply:${messageId}`);
          return messageId === "1" ? firstApplied : Promise.resolve();
        },
        removeReaction: (_chatId, messageId) => (calls.push(`clear:${messageId}`), Promise.resolve()),
      },
      ledger,
      () => {},
      REACTIONS,
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

  // docs/design/11-im-conversation.md §Status
  describe("item receipts", () => {
    // Began after every mark in these tests: its scope takes them all.
    const turn = { completedAt: Date.now() + 60_000, durationMs: 1000, tokens: 1 };
    const view = (items: [string, string][]) => ({ text: "x", items: items.map(([problem, status]) => ({ problem, status })) });

    it("a turn that opened an item takes its 👀 off and books it under the problem, wearing nothing", async () => {
      const { receipts, calls, ledger } = recording();
      receipts.mark("D1", "D1", "1");
      let settles: boolean | undefined;
      await receipts.settleAfter("D1", async (s) => void (settles = s), turn, "storage");
      expect(settles).toBe(true);
      expect(calls).toEqual(["+eyes:1", "-eyes:1"]);
      expect(ledger.items().map((i) => [i.messageId, i.problem, i.reaction])).toEqual([["1", "storage", ""]]);
      expect(ledger.take("D1")).toEqual([]);
      // A turn with nothing on the books is told so.
      await receipts.settleAfter("D1", async (s) => void (settles = s), turn);
      expect(settles).toBe(false);
    });

    it("moves each message to its item's state, and ✅ forgets a gone problem", async () => {
      const { receipts, calls, ledger } = recording();
      for (const [id, problem] of [["1", "a"], ["2", "b"], ["3", "c"]] as const) {
        receipts.mark("D1", "D1", id);
        await receipts.settle("D1", undefined, problem);
      }
      calls.length = 0;
      const later = Date.now() + 1000;
      await receipts.items(view([["a", "running"], ["b", "waiting on you"], ["c", "stopped"]]), later);
      expect(calls).toEqual(["+question:2"]);
      // No change, no call.
      await receipts.items(view([["a", "running"], ["b", "waiting on you"], ["c", "pending release"]]), later);
      expect(calls).toHaveLength(1);
      // Running again: the ❓ comes off and nothing goes on.
      await receipts.items(view([["a", "running"], ["b", "running"], ["c", "stopped"]]), later);
      expect(calls.slice(1)).toEqual(["-question:2"]);
      await receipts.items(view([["a", "running"], ["c", "stopped"]]), later);
      expect(calls.slice(2)).toEqual(["+white_check_mark:2"]);
      expect(ledger.items().map((i) => i.messageId)).toEqual(["1", "3"]);
    });

    it("a 👀 an older release left on an item comes off, even while the item is stopped", async () => {
      const { receipts, calls, ledger } = recording();
      ledger.join([{ conversationId: "D1", chatId: "D1", messageId: "1" }], "a", "eyes");
      ledger.join([{ conversationId: "D1", chatId: "D1", messageId: "2" }], "b", "eyes");
      await receipts.items(view([["a", "stopped"], ["b", "waiting on you"]]), Date.now() + 1000);
      expect(calls.sort()).toEqual(["+question:2", "-eyes:1", "-eyes:2"]);
      expect(ledger.items().map((i) => i.reaction)).toEqual(["", "question"]);
    });

    it("a receipt joined after the view was read is not taken for a gone problem", async () => {
      const { receipts, calls, ledger } = recording();
      const seen = Date.now() - 1000;
      receipts.mark("D1", "D1", "1");
      await receipts.settle("D1", undefined, "new");
      await receipts.items(view([]), seen);
      expect(calls).toEqual(["+eyes:1", "-eyes:1"]);
      expect(ledger.items()).toHaveLength(1);
    });

    it("sweeps never touch item receipts", async () => {
      const { receipts, calls, ledger } = recording();
      receipts.mark("D1", "D1", "1");
      await receipts.settle("D1", undefined, "a");
      await receipts.sweep(true);
      expect(calls).toEqual(["+eyes:1", "-eyes:1"]);
      expect(ledger.takeStale(0)).toEqual([]);
      expect(ledger.items()).toHaveLength(1);
    });

    it("an item wears its state on at most 20 messages; the oldest comes clear", async () => {
      const { receipts, calls, ledger } = recording();
      for (let i = 0; i < 21; i++) {
        receipts.mark("D1", "D1", String(i));
        await receipts.settle("D1", undefined, "a");
        await new Promise((r) => setTimeout(r, 1));
        if (i === 19) await receipts.items(view([["a", "waiting on you"]]), Date.now() + 1000);
      }
      expect(calls.filter((c) => c.startsWith("-") && !c.startsWith("-eyes"))).toEqual(["-question:0"]);
      expect(ledger.items()).toHaveLength(20);
      expect(ledger.items()[0]!.messageId).toBe("1");
    });
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
