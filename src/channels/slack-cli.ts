// `pier slack <subcommand> …`: Slack from a shell for an agent session, with
// the bot token handed in by cli.ts (env or vault) and never printed. Reads
// paginate fully and can land on disk (`--out`); every failure is one
// `slack: <method>: <code>` line on stderr, Slack's own code verbatim.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isBlockRejection,
  SlackApi,
  type SlackHistoryPage,
  type SlackMessageEvent,
  type SlackResponse,
} from "./slack-api.js";
import { SlackDirectory } from "./slack-directory.js";
import { markdown, MARKDOWN_MAX } from "./slack-render.js";
import {
  header,
  localStamp,
  ordered,
  renderMessage,
  type Threaded,
  transcript,
  type TranscriptOptions,
} from "./slack-transcript.js";

export interface SlackCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  stdin(): string;
}

/** 429s one call sits through before giving up: a batch process can wait. */
const RETRIES = 4;
const PAGE = 200;
/** Epoch seconds at the year 2100: past this, the caller meant milliseconds,
 *  and Slack would answer an empty read indistinguishable from a quiet channel. */
const MAX_SECONDS = 4_102_444_800;
/** Downloads are not the inbox: a cap only against a runaway response. */
const DOWNLOAD_MAX = 1 << 30;

class SlackCliError extends Error {
  constructor(where: string, code: string) {
    super(`${where}: ${code}`);
  }
}

type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; title?: string };
};

type Conversation = {
  id: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
};

const displayName = (u: SlackUser): string => u.profile?.display_name || u.real_name || u.name || u.id;

// --- targets ---------------------------------------------------------------

const PERMALINK = /^https:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{6,})/;

/** `{channel, ts, thread}` from a pasted message link; `p<digits>` is the ts without its dot. */
export function permalink(url: string): { channel: string; ts: string; thread?: string } | undefined {
  const m = PERMALINK.exec(url);
  if (!m) return undefined;
  const [, channel, digits] = m as unknown as [string, string, string];
  const thread = new URL(url).searchParams.get("thread_ts") ?? undefined;
  return { channel, ts: `${digits.slice(0, -6)}.${digits.slice(-6)}`, ...(thread ? { thread } : {}) };
}

// --- time ------------------------------------------------------------------

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6})\d*)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** ISO 8601 (naive = local), epoch seconds, or a Slack ts → a Slack ts. */
export function toTs(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    seconds = Number(raw);
  } else {
    const m = ISO.exec(raw);
    if (!m) throw new SlackCliError("time", `not a time: ${value}`);
    const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0", zone] = m;
    const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, "0").slice(0, 3))] as const;
    if (!zone) {
      seconds = new Date(...parts).getTime() / 1000;
    } else {
      const offset = zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
      seconds = Date.UTC(...parts) / 1000 - offset * 60;
    }
  }
  if (seconds > MAX_SECONDS) {
    throw new SlackCliError("time", `${value} is past the year 2100 — Slack times are epoch seconds, not milliseconds`);
  }
  // A ts is an id as well as a time: never rewritten.
  return /^\d+\.\d+$/.test(raw) ? raw : seconds.toFixed(6);
}

// --- the client --------------------------------------------------------------

class Client {
  readonly api: SlackApi;
  readonly directory: SlackDirectory;
  private users?: SlackUser[];

  constructor(token: string, readonly io: SlackCliIo) {
    this.api = new SlackApi(token, "", (m) => io.stderr(`slack: ${m}`), undefined, RETRIES);
    this.directory = new SlackDirectory((m) => io.stderr(`slack: ${m}`));
  }

  /** Every page of a cursor-paginated list. */
  async pages<T>(load: (cursor?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await load(cursor);
      out.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return out;
  }

  listPages<T>(method: string, key: string, params: Record<string, string | number | boolean | undefined>): Promise<T[]> {
    return this.pages(async (cursor) => {
      const body = await this.api.read<SlackResponse & { response_metadata?: { next_cursor?: string } }>(
        method,
        { ...params, limit: PAGE, cursor },
      );
      return { items: (body[key] as T[] | undefined) ?? [], next: body.response_metadata?.next_cursor || undefined };
    });
  }

  messages(load: (cursor?: string) => Promise<SlackHistoryPage>): Promise<SlackMessageEvent[]> {
    return this.pages(async (cursor) => {
      const page = await load(cursor);
      return { items: page.messages, next: page.nextCursor };
    });
  }

  /** Once per invocation, for name → user; a transcript resolves ids one by one. */
  async members(): Promise<SlackUser[]> {
    this.users ??= await this.listPages<SlackUser>("users.list", "members", {});
    return this.users;
  }

  /** An id as is; `#name` or `name` looked up, since people say channels by name. */
  async channel(given: string): Promise<string> {
    if (/^[CDG][A-Z0-9]+$/.test(given)) return given;
    const wanted = given.replace(/^#/, "").toLowerCase();
    const convs = await this.listPages<Conversation>("conversations.list", "channels", {
      exclude_archived: true,
      types: "public_channel,private_channel",
    });
    const hit = convs.find((c) => (c.name ?? "").toLowerCase() === wanted);
    if (!hit) throw new SlackCliError("channel", `no channel named #${wanted} — see \`channels\``);
    return hit.id;
  }

  /** Display names for every user who spoke; bots name themselves. */
  names(messages: Threaded[]): Promise<Map<string, string>> {
    const ids = messages.flatMap((m) => [m, ...(m.replies ?? [])]).map((m) => m.user ?? "").filter(Boolean);
    return this.directory.names(this.api, ids);
  }

  emit(lines: string[], out: string | undefined, summary: string): void {
    if (out) {
      writeFileSync(out, `${lines.join("\n")}\n`);
      this.io.stdout(`wrote ${summary} to ${resolve(out)}`);
    } else {
      this.io.stdout(lines.join("\n"));
    }
  }

  /** Raw API objects for a second script to process, so the model never reads them. */
  emitJson(data: unknown, out: string | undefined, summary: string): void {
    this.emit([JSON.stringify(data)], out, summary);
  }
}

// --- arguments -----------------------------------------------------------

const OPTIONS = {
  since: { type: "string" },
  until: { type: "string" },
  after: { type: "string" },
  thread: { type: "string" },
  out: { type: "string" },
  dir: { type: "string" },
  comment: { type: "string" },
  threads: { type: "boolean" },
  ts: { type: "boolean" },
  ids: { type: "boolean" },
  json: { type: "boolean" },
} as const;
type Flag = keyof typeof OPTIONS;

interface Args {
  channel: string;
  ts?: string;
  thread?: string;
  text: string;
  who: string;
  id: string;
  emoji: string;
  path: string;
  since?: string;
  until?: string;
  after?: string;
  out?: string;
  dir?: string;
  comment?: string;
  threads: boolean;
  json: boolean;
  render: TranscriptOptions;
}

interface Command {
  /** Positionals in order; a trailing `?` marks the optional `ts` a link supplies. */
  args: string[];
  flags: Flag[];
  help: string;
  run(client: Client, a: Args): Promise<void>;
}

/** What a pasted link stands for: the `message` itself, the `thread` it
 *  belongs to, or the place a `reply` goes. Resolves `channel` in place. */
async function target(client: Client, cmd: Command, a: Args, linkIs: "message" | "thread" | "reply" = "message"): Promise<void> {
  const link = permalink(a.channel);
  const hasTs = cmd.args.includes("ts?");
  const hasThread = cmd.flags.includes("thread");
  if (link) {
    a.channel = link.channel;
    if (linkIs === "reply") {
      a.thread = a.thread ?? link.thread ?? link.ts;
    } else if (a.ts === undefined) {
      a.ts = linkIs === "thread" ? link.thread ?? link.ts : link.ts;
      if (hasThread && a.thread === undefined && link.thread && link.thread !== link.ts) a.thread = link.thread;
    }
  } else {
    a.channel = await client.channel(a.channel);
  }
  if (hasTs && a.ts === undefined) {
    throw new SlackCliError("ts", "required — a message ts, or a Slack link in place of <channel> <ts>");
  }
}

function readText(io: SlackCliIo, arg: string): string {
  const text = arg === "-" ? io.stdin() : arg;
  if (!text.trim()) throw new SlackCliError("text", "empty");
  if (text.length > MARKDOWN_MAX) {
    throw new SlackCliError("text", `${text.length} chars; Slack takes ${MARKDOWN_MAX} per message — split it across replies`);
  }
  return text;
}

/** A plain `@alice` looks like it worked and notifies nobody; said, not refused — a name in prose is fine. */
function warnInertMention(io: SlackCliIo, text: string): void {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|<[^>]*>/g, "");
  const hit = /(?:^|\s)([@#][A-Za-z][\w.-]*)/.exec(prose);
  if (!hit) return;
  const word = hit[1]!;
  const needs = word.startsWith("#")
    ? "<#C…>"
    : ["here", "channel", "everyone"].includes(word.slice(1)) ? `<!${word.slice(1)}>` : "<@U…>";
  io.stderr(`slack: note: ${word} is plain text and notified nobody — Slack needs ${needs}; edit this ts if it was meant to reach someone`);
}

/** Slack's own markdown renderer; a workspace that predates the block gets plain text. */
async function send<T>(withBlocks: () => Promise<T>, plain: () => Promise<T>): Promise<T> {
  try {
    return await withBlocks();
  } catch (err) {
    if (!isBlockRejection(err)) throw err;
    return plain();
  }
}

const COMMANDS: Record<string, Command> = {
  whoami: {
    args: [],
    flags: [],
    help: "your bot's user id and team — the id your own messages carry",
    async run(client) {
      const a = await client.api.read<SlackResponse & { user_id?: string; bot_id?: string; team_id?: string; user?: string; team?: string }>("auth.test", {});
      client.io.stdout(`user ${a.user_id ?? ""} bot ${a.bot_id ?? ""} team ${a.team_id ?? ""} (${a.user ?? ""} @ ${a.team ?? ""})`);
    },
  },
  channels: {
    args: [],
    flags: ["json", "out"],
    help: "every conversation the bot can reach",
    async run(client, a) {
      const convs = await client.listPages<Conversation>("conversations.list", "channels", {
        exclude_archived: true,
        types: "public_channel,private_channel,mpim,im",
      });
      // Channels the bot is in first, DMs last, names alphabetical.
      const rank = (c: Conversation): string =>
        `${c.is_member === false ? 1 : 0}${c.is_im || c.is_mpim ? 1 : 0}${c.name ?? ""}`;
      convs.sort((x, y) => rank(x).localeCompare(rank(y)));
      const summary = `${convs.length} conversations`;
      if (a.json) return client.emitJson(convs, a.out, summary);
      const lines: string[] = [];
      for (const c of convs) {
        const label = c.is_im
          ? `dm ${c.user ? await client.directory.user(client.api, c.user) : ""}`
          : c.is_mpim ? `group ${c.name ?? ""}` : `#${c.name ?? ""}`;
        const notes = [c.is_private && !c.is_im && !c.is_mpim ? "private" : "", c.is_member === false ? "not a member" : ""];
        lines.push([`${c.id} ${label}`, ...notes].filter(Boolean).join(" · "));
      }
      client.emit(lines, a.out, summary);
    },
  },
  user: {
    args: ["who"],
    flags: ["json"],
    help: "one person by id or name: id, display name, real name, title, timezone",
    async run(client, a) {
      let u: SlackUser;
      if (/^[UW][A-Z0-9]+$/.test(a.who)) {
        const body = await client.api.read<SlackResponse & { user?: SlackUser }>("users.info", { user: a.who });
        u = body.user ?? { id: a.who };
      } else {
        const wanted = a.who.replace(/^@/, "").toLowerCase();
        const hits = (await client.members()).filter((m) =>
          [m.profile?.display_name, m.real_name, m.name].some((n) => (n ?? "").toLowerCase() === wanted));
        if (hits.length !== 1) {
          const list = hits.map((h) => `${h.id} ${displayName(h)}`).join(", ");
          throw new SlackCliError("user", `${hits.length} users named ${a.who}${list ? `: ${list}` : ""}`);
        }
        u = hits[0]!;
      }
      if (a.json) return client.emitJson(u, undefined, "");
      const name = displayName(u);
      client.io.stdout([
        u.id,
        name,
        u.real_name && u.real_name !== name ? `(${u.real_name})` : "",
        u.profile?.title ?? "",
        u.tz ?? "",
        u.is_bot ? "bot" : "",
        u.deleted ? "deleted" : "",
      ].filter(Boolean).join(" "));
    },
  },
  history: {
    args: ["channel"],
    flags: ["since", "until", "after", "threads", "ts", "ids", "json", "out"],
    help: "top-level messages, oldest first, every page",
    async run(client, a) {
      await target(client, this, a);
      const after = toTs(a.after);
      const since = after ?? toTs(a.since);
      const until = toTs(a.until);
      const msgs: Threaded[] = ordered(
        await client.messages((cursor) => client.api.history(a.channel, { oldest: since, latest: until, limit: PAGE, cursor })),
        after,
      );
      let threads = 0;
      for (const m of msgs) {
        if (!a.threads || !m.reply_count) continue;
        threads += 1;
        const replies = ordered(await client.messages((cursor) => client.api.replies(a.channel, m.ts!, { limit: PAGE, cursor })));
        m.replies = replies.filter((r) => r.ts !== m.ts);
      }
      const summary = `${msgs.length} messages${a.threads ? `, ${threads} threads expanded` : ""}`;
      if (a.json) return client.emitJson(msgs, a.out, summary);
      const scope = `${a.channel} ${since ? localStamp(since) : "start"} → ${until ? localStamp(until) : "now"}`;
      const lines = [header(scope, msgs.length, msgs.at(-1)?.ts), ...transcript(msgs, await client.names(msgs), a.render)];
      client.emit(lines, a.out, summary);
    },
  },
  thread: {
    args: ["channel", "ts?"],
    flags: ["after", "ts", "ids", "json", "out"],
    help: "one thread, oldest first",
    async run(client, a) {
      await target(client, this, a, "thread");
      const after = toTs(a.after);
      const msgs = ordered(
        await client.messages((cursor) => client.api.replies(a.channel, a.ts!, { oldest: after, limit: PAGE, cursor })),
        after,
      );
      const summary = `${msgs.length} messages`;
      if (a.json) return client.emitJson(msgs, a.out, summary);
      const lines = [
        header(`${a.channel}/${a.ts!}`, msgs.length, msgs.at(-1)?.ts),
        ...transcript(msgs, await client.names(msgs), { ...a.render, thread: true }),
      ];
      client.emit(lines, a.out, summary);
    },
  },
  message: {
    args: ["channel", "ts?"],
    flags: ["thread", "ts", "ids", "json"],
    help: "one message; a reply inside a thread is found through its thread",
    async run(client, a) {
      await target(client, this, a);
      const pick = (page: SlackHistoryPage): SlackMessageEvent | undefined => page.messages.find((m) => m.ts === a.ts);
      // A reply lives only in its thread: history cannot see it, replies can.
      let found = a.thread
        ? pick(await client.api.replies(a.channel, a.thread, { oldest: a.ts, limit: 20 }))
        : pick(await client.api.history(a.channel, { oldest: a.ts, latest: a.ts, limit: 1 }));
      if (!found && !a.thread) found = pick(await client.api.replies(a.channel, a.ts!, { limit: 1 }));
      if (!found) {
        throw new SlackCliError("message", `no message ${a.ts!} in ${a.channel}${a.thread ? "" : " — a reply inside a thread may need --thread"}`);
      }
      if (a.json) return client.emitJson(found, undefined, "");
      client.emit(renderMessage(found, await client.names([found]), a.render), undefined, "");
    },
  },
  permalink: {
    args: ["channel", "ts?"],
    flags: [],
    help: "a message's link, for citing it",
    async run(client, a) {
      await target(client, this, a);
      const body = await client.api.read<SlackResponse & { permalink?: string }>("chat.getPermalink", { channel: a.channel, message_ts: a.ts });
      client.io.stdout(body.permalink ?? "");
    },
  },
  file: {
    args: ["id"],
    flags: ["dir"],
    help: "download an upload by F… id, prints the path",
    async run(client, a) {
      const file = await client.api.filesInfo(a.id);
      const name = (file.name ?? a.id).replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^[._]+|[._]+$/g, "") || a.id;
      const dir = a.dir ?? ".";
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, `${a.id}-${name}`);
      const { bytes } = await client.api.downloadFile(file, DOWNLOAD_MAX);
      writeFileSync(path, bytes);
      client.io.stdout(path);
    },
  },
  post: {
    args: ["channel", "text"],
    flags: ["thread"],
    help: "post markdown (`-` = stdin), prints the ts",
    async run(client, a) {
      await target(client, this, a, "reply");
      const text = readText(client.io, a.text);
      const base = { channel: a.channel, thread_ts: a.thread, text };
      const sent = await send(
        () => client.api.postMessage({ ...base, blocks: [markdown(text)] }),
        () => client.api.postMessage(base),
      );
      client.io.stdout(sent.ts);
      warnInertMention(client.io, text);
    },
  },
  edit: {
    args: ["channel", "ts?", "text"],
    flags: [],
    help: "replace a message outright",
    async run(client, a) {
      await target(client, this, a);
      const text = readText(client.io, a.text);
      const base = { channel: a.channel, ts: a.ts!, text };
      await send(
        () => client.api.updateMessage({ ...base, blocks: [markdown(text)] }),
        () => client.api.updateMessage(base),
      );
      client.io.stdout(a.ts!);
      warnInertMention(client.io, text);
    },
  },
  delete: {
    args: ["channel", "ts?"],
    flags: [],
    help: "delete a message — no undo",
    async run(client, a) {
      await target(client, this, a);
      await client.api.deleteMessage(a.channel, a.ts!);
      client.io.stdout(`deleted ${a.ts!}`);
    },
  },
  react: {
    args: ["channel", "ts?", "emoji"],
    flags: [],
    help: "add a reaction (`+1` or `:+1:`)",
    async run(client, a) {
      await target(client, this, a);
      const name = a.emoji.replace(/^:|:$/g, "");
      await client.api.addReaction(a.channel, a.ts!, name);
      client.io.stdout(`:${name}: on ${a.ts!}`);
    },
  },
  upload: {
    args: ["channel", "path"],
    flags: ["thread", "comment"],
    help: "share a file from disk, prints its F… id",
    async run(client, a) {
      await target(client, this, a, "reply");
      const name = basename(a.path);
      const { id } = await client.api.uploadFile(a.channel, a.thread, { name, bytes: readFileSync(a.path) }, a.comment);
      client.io.stdout(`${id} ${name} → ${a.channel}${a.thread ? ` thread ${a.thread}` : ""}`);
    },
  },
};

const usageOf = (name: string, cmd: Command): string => {
  const flags = cmd.flags.map((f) => (OPTIONS[f].type === "boolean" ? `[--${f}]` : `[--${f} X]`));
  return [`pier slack ${name}`, ...cmd.args.map((p) => (p.endsWith("?") ? `[<${p.slice(0, -1)}>]` : `<${p}>`)), ...flags].join(" ");
};

export const USAGE = [
  "usage: pier slack <subcommand> … — Slack from a shell (skills/pier-slack)",
  ...Object.entries(COMMANDS).map(([name, cmd]) => `  ${usageOf(name, cmd).slice("pier slack ".length)}\n      ${cmd.help}`),
].join("\n");

const processIo: SlackCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  stdin: () => readFileSync(0, "utf8"),
};

/** The exit code: 0, 1 for a Slack or local failure, 2 for a malformed command
 *  line. `token` is asked for only once the command line parses: `--help`
 *  and a usage error must not touch the vault. */
export async function runSlackCli(argv: string[], token: () => Promise<string>, io: SlackCliIo = processIo): Promise<number> {
  const usage = (message: string): number => {
    io.stderr(`slack: ${message}`);
    return 2;
  };
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 2;
  }
  const cmd = COMMANDS[name];
  if (!cmd) return usage(`unknown subcommand "${name}"\n${USAGE}`);
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    return usage(`${err instanceof Error ? err.message : String(err)}\n${usageOf(name, cmd)}`);
  }
  const { values, positionals } = parsed;
  const stray = (Object.keys(values) as Flag[]).find((flag) => !cmd.flags.includes(flag));
  if (stray) return usage(`--${stray} is not an option of ${name}\n${usageOf(name, cmd)}`);
  const required = cmd.args.filter((p) => !p.endsWith("?")).length;
  if (positionals.length < required || positionals.length > cmd.args.length) return usage(usageOf(name, cmd));
  // The optional `ts` takes an argument only when there is one to spare: a
  // link in `<channel>` supplies it, so `edit <link> "text"` has two positionals.
  const given = [...positionals];
  const a = { threads: false, json: false, render: {} } as Args;
  cmd.args.forEach((spec, i) => {
    if (spec.endsWith("?") && given.length < cmd.args.length - i) return;
    a[spec.replace("?", "") as "channel" | "ts" | "text" | "who" | "id" | "emoji" | "path"] = given.shift()!;
  });
  Object.assign(a, {
    since: values.since,
    until: values.until,
    after: values.after,
    thread: values.thread,
    out: values.out,
    dir: values.dir,
    comment: values.comment,
    threads: values.threads === true,
    json: values.json === true,
    render: { ts: values.ts === true, ids: values.ids === true },
  });
  try {
    await cmd.run(new Client(await token(), io), a);
    return 0;
  } catch (err) {
    // SlackApi says `slack <method>: <code>`; the line here starts `slack: `.
    const text = err instanceof Error ? err.message.replace(/^slack /, "") : String(err);
    io.stderr(`slack: ${text}`);
    return 1;
  }
}
