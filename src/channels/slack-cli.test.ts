// `pier slack` against a scripted slack.com: `fetch` is stubbed, so the whole
// path from argv to the wire and back to stdout runs, and nothing leaves the
// process. Time expectations go through the renderer's own local-time helpers
// so the suite passes in any timezone.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permalink, runSlackCli, toTs } from "./slack-cli.js";
import { localDate, localStamp, localTime, tzLabel } from "./slack-transcript.js";

const API = "https://slack.com/api/";

type Answer = Record<string, unknown> | { status: 429; retryAfter?: number };

/** Answers by method; a list answers page by page, the last one repeating. */
class FakeSlack {
  readonly calls: { method: string; form: Record<string, unknown>; auth?: string }[] = [];
  readonly other: { url: string; method: string; body?: string; auth?: string }[] = [];
  private readonly answers: Record<string, Answer[]>;
  bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  constructor(answers: Record<string, Answer | Answer[]>) {
    this.answers = Object.fromEntries(
      Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
    );
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization") ?? undefined;
    if (!url.startsWith(API)) {
      this.other.push({ url, method: init.method ?? "GET", body: init.body ? String(init.body) : undefined, auth });
      if (url.startsWith("https://files.slack.com/up/")) return new Response("OK", { status: 200 });
      return new Response(this.bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    const method = url.slice(API.length);
    const raw = String(init.body ?? "");
    const form: Record<string, unknown> = headers.get("content-type")?.includes("json")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
    this.calls.push({ method, form, auth });
    const queue = this.answers[method];
    if (!queue?.length) return json({ ok: false, error: `unexpected ${method}` });
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    if ("status" in answer && answer.status === 429) {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": String(answer.retryAfter ?? 5), "content-type": "application/json" },
      });
    }
    return json(answer);
  };

  forms(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.form);
  }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** users.info answers per id — the directory asks one id at a time — told
 *  apart from a literal answer by the missing `ok`. */
const userInfo = (users: Record<string, string>): Answer => users;

interface Result {
  code: number;
  out: string;
  err: string;
}

let fake: FakeSlack;
let stdin = "";
let tokenAsked = 0;

async function run(argv: string[], answers: Record<string, Answer | Answer[]>, token = "xoxb-test"): Promise<Result> {
  fake = new FakeSlack(answers);
  // users.info is asked per id; a user-keyed table answers whichever id was asked.
  const info = answers["users.info"];
  if (info && !Array.isArray(info) && !("ok" in info)) {
    const users = info as Record<string, string>;
    const original = fake.fetch;
    fake.fetch = async (input, init) => {
      const url = String(input);
      if (url === `${API}users.info`) {
        const id = new URLSearchParams(String(init?.body ?? "")).get("user") ?? "";
        fake.calls.push({ method: "users.info", form: { user: id } });
        return users[id]
          ? json({ ok: true, user: { id, real_name: users[id] } })
          : json({ ok: false, error: "user_not_found" });
      }
      return original(input, init);
    };
  }
  vi.stubGlobal("fetch", fake.fetch);
  let out = "";
  let err = "";
  const done = runSlackCli(argv, async () => {
    tokenAsked += 1;
    return token;
  }, {
    stdout: (line) => (out += `${line}\n`),
    stderr: (line) => (err += `${line}\n`),
    stdin: () => stdin,
  });
  // Rate-limit waits are fake timers; everything else resolves on its own.
  await vi.runAllTimersAsync();
  return { code: await done, out, err };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  stdin = "";
  tokenAsked = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const t = localTime;
const scratch = (): string => mkdtempSync(join(tmpdir(), "slack-cli-"));

describe("token", () => {
  it("sends the token as a bearer header only, and asks for it once", async () => {
    const { code, out } = await run(["whoami"], {
      "auth.test": { ok: true, user_id: "U9", bot_id: "B1", team_id: "T1", user: "pier", team: "acme" },
    });
    expect(code).toBe(0);
    expect(out).toBe("user U9 bot B1 team T1 (pier @ acme)\n");
    expect(fake.calls[0]!.auth).toBe("Bearer xoxb-test");
    expect(fake.calls[0]!.form).not.toHaveProperty("token");
    expect(tokenAsked).toBe(1);
  });

  it("never asks for a token to print usage or refuse a bad command line", async () => {
    expect((await run(["--help"], {})).code).toBe(0);
    expect((await run([], {})).code).toBe(2);
    const bad = await run(["history"], {});
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("pier slack history <channel>");
    const stray = await run(["history", "C1", "--thread", "1"], {});
    expect(stray.code).toBe(2);
    expect(stray.err).toContain("--thread is not an option of history");
    expect((await run(["nope"], {})).err).toContain('unknown subcommand "nope"');
    expect(tokenAsked).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

describe("time", () => {
  it("accepts iso, epoch seconds and a ts, and never rewrites a ts", () => {
    expect(toTs("1712.345600")).toBe("1712.345600");
    expect(toTs("1712")).toBe("1712.000000");
    expect(toTs("1970-01-01T00:28:32Z")).toBe("1712.000000");
    expect(toTs("1970-01-01T00:28:32+00:00")).toBe("1712.000000");
    expect(toTs("1970-01-01T02:28:32+02:00")).toBe("1712.000000");
    expect(toTs(undefined)).toBeUndefined();
    expect(toTs("")).toBeUndefined();
  });

  it("reads a naive iso time as local", () => {
    const want = new Date(2024, 5, 1, 12, 0).getTime() / 1000;
    expect(toTs("2024-06-01T12:00")).toBe(want.toFixed(6));
    expect(toTs("2024-06-01")).toBe((new Date(2024, 5, 1).getTime() / 1000).toFixed(6));
  });

  it("refuses milliseconds and nonsense", () => {
    expect(() => toTs("1712345600000")).toThrow(/epoch seconds, not milliseconds/);
    expect(() => toTs("yesterday")).toThrow(/not a time: yesterday/);
  });
});

describe("history", () => {
  const names = userInfo({ U1: "Ada Lovelace", U2: "Bob" });

  it("renders a header, a date line, then HH:MM name: text, oldest first", async () => {
    const { code, out, err } = await run(["history", "C1"], {
      "users.info": names,
      "conversations.history": {
        ok: true,
        messages: [
          { ts: "1700.000200", user: "U2", text: "restarting it" },
          { ts: "1700.000100", user: "U1", text: "the db is on fire", reply_count: 3, files: [{ id: "F1", name: "log.txt", size: 2048 }] },
          { ts: "1700.000300", bot_id: "B7", bot_profile: { name: "Grafana" }, text: "FIRING" },
          { ts: "1700.000400", user: "U404", text: "who am i" },
        ],
      },
    });
    expect(err).toBe("slack: users.info failed for U404 (is users:read granted?): Error: slack users.info: user_not_found\n");
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      `# C1 start → now · ${tzLabel()} · 4 messages · last 1700.000400`,
      localDate("1700.000100"),
      `${t("1700.000100")} Ada Lovelace: the db is on fire [thread 3 · 1700.000100] [file log.txt F1 2KB]`,
      `${t("1700.000200")} Bob: restarting it`,
      `${t("1700.000300")} Grafana: FIRING`,
      `${t("1700.000400")} U404: who am i`,
      "",
    ]);
    // One users.info per speaker, no users.list; a bot is never looked up.
    expect(fake.forms("users.info").map((f) => f.user)).toEqual(["U1", "U2", "U404"]);
    expect(fake.forms("conversations.history")[0]).toMatchObject({ channel: "C1", limit: "200", inclusive: "true" });
  });

  it("--ts prefixes the ts and --ids appends the id", async () => {
    const { out } = await run(["history", "C1", "--ts", "--ids"], {
      "users.info": names,
      "conversations.history": {
        ok: true,
        messages: [
          { ts: "1700.000100", user: "U1", text: "hi" },
          { ts: "1700.000300", bot_id: "B7", bot_profile: { name: "Grafana" }, text: "FIRING" },
          { ts: "1700.000400", user: "U404", text: "who" },
        ],
      },
    });
    expect(out.split("\n").slice(2, 5)).toEqual([
      `1700.000100 ${t("1700.000100")} Ada Lovelace[U1]: hi`,
      `1700.000300 ${t("1700.000300")} Grafana[B7]: FIRING`,
      `1700.000400 ${t("1700.000400")} U404: who`,
    ]);
  });

  it("expands threads under their parent, two spaces in, wrapped lines four more", async () => {
    const dir = scratch();
    const path = join(dir, "out.txt");
    const { code, out } = await run(["history", "C1", "--threads", "--out", path], {
      "users.info": names,
      "conversations.history": {
        ok: true,
        messages: [
          { ts: "1700.000100", user: "U1", text: "parent", reply_count: 1 },
          { ts: "1700.000900", user: "U2", text: "later\nsecond line" },
        ],
      },
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1700.000100", user: "U1", text: "parent", reply_count: 1 },
          { ts: "1700.000150", user: "U2", thread_ts: "1700.000100", text: "child\nsecond line" },
        ],
      },
    });
    expect(code).toBe(0);
    expect(out).toBe(`wrote 2 messages, 1 threads expanded to ${path}\n`);
    expect(readFileSync(path, "utf8").split("\n")).toEqual([
      `# C1 start → now · ${tzLabel()} · 2 messages · last 1700.000900`,
      localDate("1700.000100"),
      `${t("1700.000100")} Ada Lovelace: parent [thread 1 · 1700.000100]`,
      `  ${t("1700.000150")} Bob: child`,
      "      second line",
      `${t("1700.000900")} Bob: later`,
      "    second line",
      "",
    ]);
    expect(fake.forms("conversations.replies")).toHaveLength(1);
  });

  it("puts a date line wherever the local day changes", async () => {
    const dayOne = "1700000000.000100";
    const dayTwo = String(1700000000 + 86_400) + ".000100";
    const { out } = await run(["history", "C1"], {
      "users.info": names,
      "conversations.history": {
        ok: true,
        messages: [{ ts: dayTwo, user: "U1", text: "b" }, { ts: dayOne, user: "U1", text: "a" }],
      },
    });
    expect(out.split("\n").slice(1, 5)).toEqual([
      localDate(dayOne),
      `${t(dayOne)} Ada Lovelace: a`,
      localDate(dayTwo),
      `${t(dayTwo)} Ada Lovelace: b`,
    ]);
  });

  it("sends since/until/after as ts and keeps --after strict", async () => {
    const { code, out } = await run(
      ["history", "C1", "--after", "1700.000100", "--until", "1970-01-01T00:28:32Z"],
      {
        "users.info": names,
        "conversations.history": {
          ok: true,
          messages: [{ ts: "1700.000100", user: "U1", text: "boundary" }, { ts: "1700.000200", user: "U1", text: "newer" }],
        },
      },
    );
    expect(code).toBe(0);
    expect(fake.forms("conversations.history")[0]).toMatchObject({ oldest: "1700.000100", latest: "1712.000000", inclusive: "true" });
    expect(out).not.toContain("boundary");
    expect(out).toContain("newer");
    expect(out.split("\n")[0]).toBe(
      `# C1 ${localStamp("1700.000100")} → ${localStamp("1712.000000")} · ${tzLabel()} · 1 messages · last 1700.000200`,
    );
  });

  it("walks every page and dedups the seam", async () => {
    const { out } = await run(["history", "C1"], {
      "users.info": names,
      "conversations.history": [
        {
          ok: true,
          messages: [{ ts: "1700.000300", user: "U1", text: "c" }, { ts: "1700.000200", user: "U1", text: "b" }],
          response_metadata: { next_cursor: "p2" },
        },
        {
          ok: true,
          messages: [{ ts: "1700.000200", user: "U1", text: "b" }, { ts: "1700.000100", user: "U1", text: "a" }],
          response_metadata: { next_cursor: "" },
        },
      ],
    });
    const texts = out.trimEnd().split("\n").slice(2).map((line) => line.split(": ").at(-1));
    expect(texts).toEqual(["a", "b", "c"]);
    expect(fake.forms("conversations.history").map((f) => f.cursor)).toEqual([undefined, "p2"]);
  });

  it("--json is the raw API object with replies nested, names unresolved", async () => {
    const dir = scratch();
    const path = join(dir, "raw.json");
    const answers = {
      "conversations.history": { ok: true, messages: [{ ts: "1700.000100", user: "U1", text: "p", reply_count: 1 }] },
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1700.000100", user: "U1", text: "p", reply_count: 1 },
          { ts: "1700.000150", user: "U2", thread_ts: "1700.000100", text: "c" },
        ],
      },
    };
    const { code, out } = await run(["history", "C1", "--threads", "--json", "--out", path], answers);
    expect(code).toBe(0);
    expect(out).toBe(`wrote 1 messages, 1 threads expanded to ${path}\n`);
    const data = JSON.parse(readFileSync(path, "utf8")) as { replies: { text: string }[] }[];
    expect(data[0]!.replies[0]!.text).toBe("c");
    expect(fake.forms("users.info")).toEqual([]);
    const thread = await run(["thread", "C1", "1700.000100", "--json"], answers);
    expect((JSON.parse(thread.out) as { text: string }[])[1]!.text).toBe("c");
  });
});

describe("markers", () => {
  const names = userInfo({ U1: "ada" });
  const one = async (msg: Record<string, unknown>, ...flags: string[]): Promise<string> => {
    const { out } = await run(["message", "C1", "1700.000100", ...flags], {
      "users.info": names,
      "conversations.history": { ok: true, messages: [{ ts: "1700.000100", user: "U1", ...msg }] },
    });
    return out.trimEnd();
  };

  it("marks edits, broadcasts, attachments, blocks and reactions in the spec's order", async () => {
    const at = t("1700.000100");
    expect(await one({ text: "hi", edited: { user: "U1", ts: "1700.5" } })).toBe(`${at} ada: hi [edited]`);
    expect(await one({ text: "also here", thread_ts: "1700.000050" })).toBe(`${at} ada: also here [in thread 1700.000050]`);
    expect(await one({ text: "", attachments: [{ title: "Build #42 failed" }, { fallback: "PR opened" }] }))
      .toBe(`${at} ada: [attachment: Build #42 failed] [attachment: PR opened]`);
    expect(await one({ text: "", blocks: [{ type: "section" }] })).toBe(`${at} ada: [blocks]`);
    expect(await one({ text: "ship it", reactions: [{ name: "+1", count: 3 }, { name: "eyes", count: 1 }] }))
      .toBe(`${at} ada: ship it [:+1: 3, :eyes: 1]`);
    expect(await one({ text: "", files: [{ id: "F1", name: "a.pdf", size: 2_000_000 }] })).toBe(`${at} ada: [file a.pdf F1 1.9MB]`);
    expect(await one({
      text: "all\nof it",
      edited: {},
      reply_count: 2,
      files: [{ id: "F2", mimetype: "image/png" }],
      reactions: [{ name: "eyes" }],
    })).toBe(`${at} ada: all\n    of it [edited] [thread 2 · 1700.000100] [file image/png F2] [:eyes: 1]`);
  });

  it("does not mark a reply as a thread parent, whatever reply_count says", async () => {
    expect(await one({ text: "hi", thread_ts: "1700.000050", reply_count: 2 }, "--ts")).toBe(
      `1700.000100 ${t("1700.000100")} ada: hi [in thread 1700.000050]`,
    );
  });
});

describe("thread and message", () => {
  const replies = {
    ok: true,
    messages: [
      { ts: "1700.000100", user: "U1", text: "parent", reply_count: 2 },
      { ts: "1700.000200", user: "U2", thread_ts: "1700.000100", text: "one" },
      { ts: "1700.000300", user: "U2", thread_ts: "1700.000100", text: "two" },
    ],
  };
  const names = userInfo({ U1: "ada", U2: "Bob" });

  it("reads one thread with no [in thread] noise, and --after strictly", async () => {
    const { code, out } = await run(["thread", "C1", "1700.000100", "--after", "1700.000100"], {
      "users.info": names,
      "conversations.replies": replies,
    });
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      `# C1/1700.000100 · ${tzLabel()} · 2 messages · last 1700.000300`,
      localDate("1700.000200"),
      `${t("1700.000200")} Bob: one`,
      `${t("1700.000300")} Bob: two`,
      "",
    ]);
    expect(fake.forms("conversations.replies")[0]).toMatchObject({ ts: "1700.000100", oldest: "1700.000100" });
  });

  it("finds a reply through its thread when history cannot see it", async () => {
    const { code, out } = await run(["message", "C1", "1700.000200"], {
      "users.info": names,
      "conversations.history": { ok: true, messages: [] },
      "conversations.replies": { ok: true, messages: replies.messages.slice(1, 2) },
    });
    expect(code).toBe(0);
    expect(out).toBe(`${t("1700.000200")} Bob: one [in thread 1700.000100]\n`);
    expect(fake.calls.filter((c) => c.method.startsWith("conversations")).map((c) => c.method))
      .toEqual(["conversations.history", "conversations.replies"]);
  });

  it("says how to find a reply when the message is missing, passing Slack's refusal through", async () => {
    const missing = await run(["message", "C1", "1700.000200"], {
      "conversations.history": { ok: true, messages: [] },
      "conversations.replies": { ok: true, messages: [] },
    });
    expect(missing.code).toBe(1);
    expect(missing.err).toBe("slack: message: no message 1700.000200 in C1 — a reply inside a thread may need --thread\n");
    const refused = await run(["message", "C1", "1700.000200"], {
      "conversations.history": { ok: true, messages: [] },
      "conversations.replies": { ok: false, error: "thread_not_found" },
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toBe("slack: conversations.replies: thread_not_found\n");
  });
});

describe("channels and users", () => {
  it("lists id, name, kind and membership, channels first, DMs last", async () => {
    const { code, out } = await run(["channels"], {
      "users.info": userInfo({ U1: "ada" }),
      "conversations.list": [
        { ok: true, channels: [{ id: "C1", name: "dev", is_member: true }], response_metadata: { next_cursor: "c2" } },
        {
          ok: true,
          channels: [
            { id: "D1", is_im: true, user: "U1" },
            { id: "G1", is_mpim: true, name: "mpdm-ada--bob-1" },
            { id: "C2", name: "ops", is_private: true, is_member: false },
          ],
        },
      ],
    });
    expect(code).toBe(0);
    expect(out).toBe("C1 #dev\nD1 dm ada\nG1 group mpdm-ada--bob-1\nC2 #ops · private · not a member\n");
    expect(fake.forms("conversations.list")[1]!.cursor).toBe("c2");
    const dir = scratch();
    const path = join(dir, "ch.txt");
    const saved = await run(["channels", "--out", path], { "conversations.list": { ok: true, channels: [{ id: "C1", name: "dev" }] } });
    expect(saved.out).toBe(`wrote 1 conversations to ${path}\n`);
    expect(readFileSync(path, "utf8")).toBe("C1 #dev\n");
  });

  it("takes a channel by #name, case-insensitively", async () => {
    const listing = { ok: true, channels: [{ id: "C1", name: "dev" }, { id: "C2", name: "Ops", is_private: true }] };
    const { code } = await run(["history", "#ops"], { "conversations.list": listing, "conversations.history": { ok: true, messages: [] } });
    expect(code).toBe(0);
    expect(fake.forms("conversations.history")[0]!.channel).toBe("C2");
    expect(fake.forms("conversations.list")[0]).toMatchObject({ types: "public_channel,private_channel", exclude_archived: "true" });
    const nowhere = await run(["history", "nowhere"], { "conversations.list": listing });
    expect(nowhere.code).toBe(1);
    expect(nowhere.err).toBe("slack: channel: no channel named #nowhere — see `channels`\n");
  });

  it("looks a user up by id or by name, and refuses an ambiguous name", async () => {
    const info = { ok: true, user: { id: "U1", real_name: "Ada Lovelace", tz: "Europe/London", profile: { display_name: "ada", title: "CTO" } } };
    const byId = await run(["user", "U1"], { "users.info": info });
    expect(byId.out).toBe("U1 ada (Ada Lovelace) CTO Europe/London\n");
    const members = {
      ok: true,
      members: [
        { id: "U1", real_name: "Ada Lovelace", profile: { display_name: "ada" } },
        { id: "U2", real_name: "Bob", profile: {} },
        { id: "U3", real_name: "Bob", is_bot: true, profile: {} },
      ],
    };
    const byName = await run(["user", "@ada"], { "users.list": members });
    expect(byName.out).toBe("U1 ada (Ada Lovelace)\n");
    const two = await run(["user", "bob"], { "users.list": members });
    expect(two.code).toBe(1);
    expect(two.err).toBe("slack: user: 2 users named bob: U2 Bob, U3 Bob\n");
    const none = await run(["user", "nobody"], { "users.list": members });
    expect(none.err).toBe("slack: user: 0 users named nobody\n");
    const raw = await run(["user", "U1", "--json"], { "users.info": info });
    expect((JSON.parse(raw.out) as { tz: string }).tz).toBe("Europe/London");
  });
});

describe("links", () => {
  const URL_ = "https://acme.slack.com/archives/C079TC7GUBG/p1712345600123456";
  const REPLY = `${URL_}?thread_ts=1712345500.000100&cid=C079TC7GUBG`;

  it("parses channel, ts and thread out of a permalink", () => {
    expect(permalink(URL_)).toEqual({ channel: "C079TC7GUBG", ts: "1712345600.123456" });
    expect(permalink(REPLY)).toEqual({ channel: "C079TC7GUBG", ts: "1712345600.123456", thread: "1712345500.000100" });
    expect(permalink("C079TC7GUBG")).toBeUndefined();
    expect(permalink("https://example.com/archives/C1/p1")).toBeUndefined();
  });

  it("lets a link stand in for <channel> <ts>, inferring the thread", async () => {
    const answers = {
      "users.info": userInfo({ U1: "ada" }),
      "conversations.replies": {
        ok: true,
        messages: [{ ts: "1712345600.123456", user: "U1", thread_ts: "1712345500.000100", text: "the reply" }],
      },
    };
    // A link to a reply: `message` looks inside its thread, `thread` opens the whole thread.
    const message = await run(["message", REPLY], answers);
    expect(message.code).toBe(0);
    expect(message.out).toContain("ada: the reply");
    expect(fake.forms("conversations.replies")[0]).toMatchObject({ ts: "1712345500.000100", oldest: "1712345600.123456" });
    await run(["thread", REPLY], answers);
    expect(fake.forms("conversations.replies")[0]!.ts).toBe("1712345500.000100");
    const writes = { "chat.delete": { ok: true }, "chat.update": { ok: true } };
    const deleted = await run(["delete", URL_], writes);
    expect(deleted).toEqual({ code: 0, out: "deleted 1712345600.123456\n", err: "" });
    const edited = await run(["edit", URL_, "new text"], writes);
    expect(edited).toEqual({ code: 0, out: "1712345600.123456\n", err: "" });
    expect(fake.forms("chat.update")[0]).toMatchObject({ channel: "C079TC7GUBG", ts: "1712345600.123456", text: "new text" });
    const bare = await run(["delete", "C1"], writes);
    expect(bare.code).toBe(1);
    expect(bare.err).toBe("slack: ts: required — a message ts, or a Slack link in place of <channel> <ts>\n");
  });

  it("posts to a link as a reply in its thread", async () => {
    await run(["post", URL_, "hi"], { "chat.postMessage": { ok: true, ts: "9" } });
    expect(fake.forms("chat.postMessage")[0]!.thread_ts).toBe("1712345600.123456");
    await run(["post", REPLY, "hi"], { "chat.postMessage": { ok: true, ts: "9" } });
    expect(fake.forms("chat.postMessage")[0]!.thread_ts).toBe("1712345500.000100");
  });

  it("asks Slack for a permalink", async () => {
    const { code, out } = await run(["permalink", "C079TC7GUBG", "1712345600.123456"], {
      "chat.getPermalink": { ok: true, permalink: URL_ },
    });
    expect(code).toBe(0);
    expect(out).toBe(`${URL_}\n`);
    expect(fake.forms("chat.getPermalink")[0]).toMatchObject({ channel: "C079TC7GUBG", message_ts: "1712345600.123456" });
  });
});

describe("rate limits", () => {
  const ok = { ok: true, user_id: "U9", team_id: "T1", user: "pier", team: "acme" };

  it("honours Retry-After, then an in-body ratelimited, then succeeds", async () => {
    const sleeps = vi.spyOn(globalThis, "setTimeout");
    const { code, out } = await run(["whoami"], {
      "auth.test": [{ status: 429, retryAfter: 7 }, { ok: false, error: "ratelimited" }, ok],
    });
    expect(code).toBe(0);
    expect(out).toContain("user U9");
    expect(sleeps.mock.calls.map((c) => c[1])).toEqual([8000, 2000]);
    expect(fake.forms("auth.test")).toHaveLength(3);
  });

  it("gives up after five tries with Slack's code", async () => {
    const { code, out, err } = await run(["whoami"], { "auth.test": { status: 429, retryAfter: 1 } });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("slack: auth.test: ratelimited\n");
    expect(fake.forms("auth.test")).toHaveLength(5);
  });
});

describe("errors", () => {
  it("is one line with Slack's code verbatim", async () => {
    const { code, out, err } = await run(["history", "C1"], { "conversations.history": { ok: false, error: "not_in_channel" } });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("slack: conversations.history: not_in_channel\n");
  });
});

describe("writes", () => {
  it("posts with the markdown block and prints the ts", async () => {
    const { code, out } = await run(["post", "C1", "**hi** <@U1>", "--thread", "1700.000100"], {
      "chat.postMessage": { ok: true, ts: "1700.000500" },
    });
    expect(code).toBe(0);
    expect(out).toBe("1700.000500\n");
    expect(fake.forms("chat.postMessage")[0]).toEqual({
      channel: "C1",
      thread_ts: "1700.000100",
      text: "**hi** <@U1>",
      blocks: [{ type: "markdown", text: "**hi** <@U1>" }],
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("falls back to plain text where the block is refused", async () => {
    const { code, out } = await run(["post", "C1", "hi"], {
      "chat.postMessage": [{ ok: false, error: "invalid_blocks" }, { ok: true, ts: "1" }],
    });
    expect(code).toBe(0);
    expect(out).toBe("1\n");
    const second = fake.forms("chat.postMessage")[1]!;
    expect(second).not.toHaveProperty("blocks");
    // No thread: the key is absent, not empty.
    expect(second).not.toHaveProperty("thread_ts");
  });

  it("reads stdin, refuses empty or oversized text", async () => {
    stdin = "from stdin\n";
    const piped = await run(["post", "C1", "-"], { "chat.postMessage": { ok: true, ts: "2" } });
    expect(piped.out).toBe("2\n");
    expect(fake.forms("chat.postMessage")[0]!.text).toBe("from stdin\n");
    const empty = await run(["post", "C1", "  "], {});
    expect(empty).toEqual({ code: 1, out: "", err: "slack: text: empty\n" });
    const long = await run(["post", "C1", "x".repeat(11_001)], {});
    expect(long.code).toBe(1);
    expect(long.err).toContain("split it across replies");
    expect(fake.calls).toEqual([]);
  });

  it("reports a plain mention on stderr without refusing the post", async () => {
    const posted = await run(["post", "C1", "thanks @alice, see #ops"], { "chat.postMessage": { ok: true, ts: "3" } });
    expect(posted.code).toBe(0);
    expect(posted.out).toBe("3\n");
    expect(posted.err).toBe("slack: note: @alice is plain text and notified nobody — Slack needs <@U…>; edit this ts if it was meant to reach someone\n");
    const here = await run(["edit", "C1", "3", "@here deploy done"], { "chat.update": { ok: true } });
    expect(here.err).toContain("Slack needs <!here>");
    const fine = await run(["post", "C1", "<@U1> `@alice` ```#ops``` a@b.c"], { "chat.postMessage": { ok: true, ts: "4" } });
    expect(fine.err).toBe("");
  });

  it("adds a reaction by short name, colons or not", async () => {
    const { code, out } = await run(["react", "C1", "1700.000500", ":eyes:"], { "reactions.add": { ok: true } });
    expect(code).toBe(0);
    expect(out).toBe(":eyes: on 1700.000500\n");
    expect(fake.forms("reactions.add")[0]).toEqual({ channel: "C1", timestamp: "1700.000500", name: "eyes" });
  });

  it("edits without a thread_ts and passes a delete refusal through", async () => {
    const edited = await run(["edit", "C1", "1700.000500", "new text"], { "chat.update": { ok: true } });
    expect(edited).toEqual({ code: 0, out: "1700.000500\n", err: "" });
    expect(fake.forms("chat.update")[0]).toMatchObject({ ts: "1700.000500" });
    expect(fake.forms("chat.update")[0]).not.toHaveProperty("thread_ts");
    const refused = await run(["delete", "C1", "1700.000500"], { "chat.delete": { ok: false, error: "cant_delete_message" } });
    expect(refused.code).toBe(1);
    expect(refused.err).toBe("slack: chat.delete: cant_delete_message\n");
  });
});

describe("files", () => {
  it("downloads by id into --dir with the bearer header and prints the path", async () => {
    const dir = scratch();
    const { code, out, err } = await run(["file", "F1", "--dir", dir], {
      "files.info": { ok: true, file: { id: "F1", name: "post mortem.pdf", url_private_download: "https://files.slack.com/x" } },
    });
    expect(err).toBe("");
    expect(code).toBe(0);
    const path = out.trim();
    expect(path).toBe(join(dir, "F1-post_mortem.pdf"));
    expect([...readFileSync(path)]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(fake.other).toEqual([{ url: "https://files.slack.com/x", method: "GET", body: undefined, auth: "Bearer xoxb-test" }]);
  });

  it("uploads as ticket, raw bytes, then complete — into a thread with a comment", async () => {
    const dir = scratch();
    const path = join(dir, "report.md");
    writeFileSync(path, "# weekly\n");
    const { code, out, err } = await run(["upload", "C1", path, "--thread", "1700.000100", "--comment", "this week"], {
      "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.com/up/1", file_id: "F9" },
      "files.completeUploadExternal": { ok: true, files: [{ id: "F9", title: "report.md" }] },
    });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe("F9 report.md → C1 thread 1700.000100\n");
    expect(fake.forms("files.getUploadURLExternal")[0]).toEqual({ filename: "report.md", length: "9" });
    expect(fake.other[0]).toMatchObject({ url: "https://files.slack.com/up/1", method: "POST" });
    expect(fake.forms("files.completeUploadExternal")[0]).toEqual({
      files: [{ id: "F9", title: "report.md" }],
      channel_id: "C1",
      thread_ts: "1700.000100",
      initial_comment: "this week",
    });
    const top = await run(["upload", "C1", path], {
      "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.com/up/1", file_id: "F9" },
      "files.completeUploadExternal": { ok: true, files: [{ id: "F9" }] },
    });
    expect(top.out).toBe("F9 report.md → C1\n");
    expect(fake.forms("files.completeUploadExternal")[0]).not.toHaveProperty("thread_ts");
  });
});
