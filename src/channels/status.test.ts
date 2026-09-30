import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { NOTHING_OPEN, type OpenItemsView } from "../core/types.js";
import { StatusMessage } from "./status.js";

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

const view = (text: string): OpenItemsView => ({ text, items: [] });

const rig = (fail: { edit?: boolean; post?: boolean } = {}) => {
  const calls: string[] = [];
  const logged: string[] = [];
  const handed: OpenItemsView[] = [];
  let next = 0;
  const status = new StatusMessage("slack", db, {
    post: (chat, body) => {
      calls.push(`post ${chat} ${body}`);
      return fail.post ? Promise.reject(new Error("429")) : Promise.resolve(`m${String(++next)}`);
    },
    edit: (chat, id, body) => {
      calls.push(`edit ${id} ${body}`);
      return fail.edit ? Promise.reject(new Error("message_not_found")) : Promise.resolve();
    },
    delete: (chat, id) => (calls.push(`delete ${id}`), Promise.resolve()),
  }, { items: (v) => (handed.push(v), Promise.resolve()) }, (m) => logged.push(m), (t) => `> ${t}`);
  return { status, calls, logged, handed };
};

// docs/design/11-im-conversation.md §Status
describe("the status message", () => {
  it("posts once, edits in place, and says nothing when nothing changed", async () => {
    const { status, calls, handed } = rig();
    await status.show("D1", view("a — running"));
    await status.show("D1", view("a — waiting on you"));
    await status.show("D1", view("a — waiting on you"));
    expect(calls).toEqual(["post D1 > a — running", "edit m1 > a — waiting on you"]);
    expect(handed).toHaveLength(3);
  });

  it("/status re-posts it at the bottom with the answer's text, as the one reply", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    expect(await status.answer("D1", "b")).toBe(true);
    expect(calls).toEqual(["post D1 > a", "delete m1", "post D1 > b"]);
    // Nothing open, another chat, or no view yet: the note answers.
    expect(await status.answer("D1", NOTHING_OPEN)).toBe(false);
    expect(await status.answer("D2", "b")).toBe(false);
    expect(await rig().status.answer("D1", "b")).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("/status during a running refresh still re-posts at the bottom", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    const running = status.show("D1", view("b"));
    await Promise.resolve();
    const [, answered] = await Promise.all([running, status.answer("D1", "c"), status.show("D1", view("d"))]);
    expect(answered).toBe(true);
    expect(calls).toEqual(["post D1 > a", "edit m1 > b", "delete m1", "post D1 > d"]);
  });

  it("/status whose re-post fails leaves the answer to the note", async () => {
    const { status, calls, logged } = rig({ post: true });
    await status.show("D1", view("a"));
    expect(await status.answer("D1", "a")).toBe(false);
    expect(calls).toEqual(["post D1 > a", "post D1 > a"]);
    expect(logged).toHaveLength(2);
  });

  it("is deleted when nothing is open, and not posted for nothing", async () => {
    const { status, calls } = rig();
    await status.show("D1", view(NOTHING_OPEN));
    await status.show("D1", view("a"));
    await status.show("D1", view(NOTHING_OPEN));
    await status.show("D1", view(NOTHING_OPEN));
    expect(calls).toEqual(["post D1 > a", "delete m1"]);
  });

  it("a failed edit posts anew; a failed post is logged and retried next time", async () => {
    const edits = rig({ edit: true });
    await edits.status.show("D1", view("a"));
    await edits.status.show("D1", view("b"));
    expect(edits.calls).toEqual(["post D1 > a", "edit m1 > b", "delete m1", "post D1 > b"]);
    expect(edits.logged[0]).toMatch(/^status: edit failed/);

    db.exec("DELETE FROM status_messages");
    const posts = rig({ post: true });
    await posts.status.show("D1", view("a"));
    await posts.status.show("D1", view("a"));
    expect(posts.calls).toEqual(["post D1 > a", "post D1 > a"]);
    expect(posts.logged).toHaveLength(2);
  });

  it("a home moved within the platform loses the old chat's card", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    await status.show("D2", view("a"));
    expect(calls).toEqual(["post D1 > a", "delete m1", "post D2 > a"]);
  });

  it("a burst runs one refresh at a time and ends on the newest view", async () => {
    const { status, calls } = rig();
    await Promise.all([status.show("D1", view("a")), status.show("D1", view("b")), status.show("D1", view("c"))]);
    expect(calls).toEqual(["post D1 > c"]);
    const first = status.show("D1", view("d"));
    await Promise.resolve();
    await Promise.all([first, status.show("D1", view("e")), status.show("D1", view("f"))]);
    expect(calls).toEqual(["post D1 > c", "edit m1 > d", "edit m1 > f"]);
  });

  it("survives a restart: the row is on disk", async () => {
    await rig().status.show("D1", view("a"));
    const { status, calls } = rig();
    await status.show("D1", view("b"));
    expect(calls).toEqual(["edit m1 > b"]);
  });
});
