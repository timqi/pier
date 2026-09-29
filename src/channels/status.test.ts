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

  it("re-posts below a later main-flow post and deletes the old one", async () => {
    const { status, calls } = rig();
    await status.show("D1", view("a"));
    status.behind("D1");
    await status.show("D1", view("a"));
    expect(calls).toEqual(["post D1 > a", "delete m1", "post D1 > a"]);
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

    const posts = rig({ post: true });
    await posts.status.show("D2", view("a"));
    await posts.status.show("D2", view("a"));
    expect(posts.calls).toEqual(["post D2 > a", "post D2 > a"]);
    expect(posts.logged).toHaveLength(2);
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
