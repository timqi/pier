import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { openItemPresentation } from "../core/open-items.js";
import { NOTHING_OPEN } from "../core/types.js";
import { StatusMessage, type StatusView } from "./status.js";

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-status-"));
  db = openDb(join(dir, "pier.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A view whose one item is its text, none at `NOTHING_OPEN`. */
const view = (text: string): StatusView => ({ text, snapshot: { version: 1, items: text === NOTHING_OPEN ? [] :
  [openItemPresentation({ problem: text, stage: "", status: "running", runs: [] }, 0)] } });

const rig = (fail: { edit?: boolean; post?: boolean } = {}) => {
  const calls: string[] = [];
  const logged: string[] = [];
  let next = 0;
  const status = new StatusMessage("slack", {
    post: (chat, body) => {
      calls.push(`post ${chat} ${body}`);
      return fail.post ? Promise.reject(new Error("429")) : Promise.resolve(`m${String(++next)}`);
    },
    edit: (chat, id, body) => {
      calls.push(`edit ${id} ${body}`);
      return fail.edit ? Promise.reject(new Error("message_not_found")) : Promise.resolve();
    },
  }, (m) => logged.push(m), (v) => `> ${v.text}${v.others?.length ? ` +${String(v.others.length)}` : ""}`, db);
  return { status, calls, logged };
};

// docs/design/11-im-conversation.md §Status: the API it is given has no delete.
describe("the status card", () => {
  it("posts once, edits in place, and says nothing when nothing changed", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a — running"));
    await status.show("D1", view("a — waiting on you"));
    await status.show("D1", view("a — waiting on you"));
    expect(calls).toEqual(["post D1 > a — running", "edit m1 > a — waiting on you"]);
  });

  it("/status posts a new card at the bottom, edited from then on; the old one is left as it was", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    expect(await status.answer("D1", view("b"))).toBe(true);
    await status.show("D1", view("c"));
    expect(await status.answer("D1", view("c"))).toBe(true);
    expect(calls).toEqual(["post D1 > a", "post D1 > b", "edit m2 > c", "post D1 > c"]);
  });

  it("/status with nothing open and no other chain leaves the answer to the note; another chain's line is a card", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    expect(await status.answer("D1", view(NOTHING_OPEN))).toBe(false);
    expect(calls).toEqual(["post D1 > a"]);
    const others = [{ name: "Design", waiting: 1, inProgress: 0, archived: false }];
    expect(await status.answer("D1", { ...view(NOTHING_OPEN), others })).toBe(true);
    expect(calls).toEqual(["post D1 > a", `post D1 > ${NOTHING_OPEN} +1`]);
  });

  it("/status during a running refresh still posts anew", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    const running = status.show("D1", view("b"));
    await Promise.resolve();
    const [, answered] = await Promise.all([running, status.answer("D1", view("c")), status.show("D1", view("d"))]);
    expect(answered).toBe(true);
    expect(calls).toEqual(["post D1 > a", "edit m1 > b", "post D1 > d"]);
  });

  it("/status whose post fails leaves the answer to the note and keeps the old card's row", async () => {
    let failPost = false;
    const calls: string[] = [];
    const status = new StatusMessage("slack", {
      post: (chat, body) => (calls.push(`post ${body}`), failPost ? Promise.reject(new Error("429")) : Promise.resolve("m1")),
      edit: (chat, id, body) => (calls.push(`edit ${id} ${body}`), Promise.resolve()),
    }, () => undefined, (v) => v.text, db);
    await status.show("D1", view("a"));
    failPost = true;
    expect(await status.answer("D1", view("b"))).toBe(false);
    await status.show("D1", view("c"));
    expect(calls).toEqual(["post a", "post b", "edit m1 c"]);
  });

  it("nothing open edits the card to say so, never deletes it; a later item edits it back", async () => {
    const { status, calls } = rig();
    await status.show("D1", view(NOTHING_OPEN));
    await status.show("D1", view("a"));
    await status.show("D1", view(NOTHING_OPEN));
    await status.show("D1", view(NOTHING_OPEN));
    await status.show("D1", view("b"));
    expect(calls).toEqual(["post D1 > a", `edit m1 > ${NOTHING_OPEN}`, "edit m1 > b"]);
  });

  it("a failed edit posts anew and leaves the old card; a failed post is logged and retried next time", async () => {
    const edits = rig({ edit: true });
    await edits.status.show("D1", view("a"));
    await edits.status.show("D1", view("b"));
    await edits.status.show("D1", view("c"));
    expect(edits.calls).toEqual(["post D1 > a", "edit m1 > b", "post D1 > b", "edit m2 > c", "post D1 > c"]);
    expect(edits.logged[0]).toMatch(/^status: edit failed/);

    db.exec("DELETE FROM status_messages");
    const posts = rig({ post: true });
    await posts.status.show("D1", view("a"));
    await posts.status.show("D1", view("a"));
    expect(posts.calls).toEqual(["post D1 > a", "post D1 > a"]);
    expect(posts.logged).toHaveLength(2);
  });

  it("a home moved within the platform leaves the old chat's card as it was", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    await status.show("D2", view("a"));
    await status.show("D2", view("b"));
    expect(calls).toEqual(["post D1 > a", "post D2 > a", "edit m2 > b"]);
  });

  it("a burst runs one refresh at a time and ends on the newest view", async () => {
    const { status, calls } = rig();
    await Promise.all([status.show("D1", view("a")), status.show("D1", view("b")), status.show("D1", view("c"))]);
    expect(calls).toEqual(["post D1 > c"]);
    const first = status.show("D1", view("d"));
    await Promise.resolve();
    await Promise.all([first, status.show("D1", view("e")), status.show("D1", view("f"))]);
    expect(calls).toEqual(["post D1 > c", "edit m1 > d", "edit m1 > f"]);
    // An adapter's stop waits on it, so its replacement never races the edit in flight.
    void status.show("D1", view("g"));
    await status.settled();
    expect(calls.at(-1)).toBe("edit m1 > g");
  });

  it("survives a restart: the row is on disk", async () => {
    await rig().status.show("D1", view("a"));
    const { status, calls } = rig();
    await status.show("D1", view("b"));
    expect(calls).toEqual(["edit m1 > b"]);
  });
});
