// The settings panel, through Slack's rendering of the shared behaviour.
// Hermetic — in-memory store, a recording control, a fake client.

import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import type { AgentLaunchOptions, ConversationKey, ModelRef, SessionSummary } from "../core/types.js";
import { ChannelStore } from "./config.js";
import { type ChannelControl, type ConversationStatus, NO_SESSION } from "./control.js";
import { HandoffError } from "./handoff.js";
import type { PanelHandoff } from "./panel.js";
import { SlackPanel } from "./slack-panel.js";
import type { SlackBlock, SlackClient, SlackInteraction } from "./slack-api.js";

const MODELS: ModelRef[] = Array.from({ length: 10 }, (_, i) => ({
  provider: "anthropic",
  id: `model-${i}`,
}));

const status = (over: Partial<ConversationStatus> = {}): ConversationStatus => ({
  sessionId: "0123456789abcdef",
  cwd: "/srv/pier",
  state: "idle",
  empty: false,
  model: MODELS[0],
  thinking: "off",
  thinkingLevels: ["off", "high"],
  tokens: 1200,
  contextWindow: 200_000,
  ...over,
});

class FakeControl implements ChannelControl {
  current: ConversationStatus | null = status();
  readonly newSessions: (string | undefined)[] = [];
  dirs: string[] | Error = ["/home/qiqi/code/dev/pier", "/srv/ops"];
  readonly setModels: ModelRef[] = [];
  aborted = 0;
  launch: Partial<AgentLaunchOptions> = {};
  launchFor = (): Partial<AgentLaunchOptions> => this.launch;
  knows = () => true;
  abort = (): Promise<void> => {
    this.aborted++;
    return Promise.resolve();
  };
  status = (): Promise<ConversationStatus | null> => Promise.resolve(this.current);
  models = (): Promise<ModelRef[]> => Promise.resolve(MODELS);
  setModel = (_k: ConversationKey, model: ModelRef): Promise<void> => {
    this.setModels.push(model);
    return Promise.resolve();
  };
  setThinking = (): Promise<void> =>
    this.current ? Promise.resolve() : Promise.reject(new Error(NO_SESSION));
  newSession = (_k: ConversationKey, cwd?: string): Promise<string> => {
    this.newSessions.push(cwd);
    return Promise.resolve("abcdef0123");
  };
  recentDirs = (): Promise<string[]> =>
    this.dirs instanceof Error ? Promise.reject(this.dirs) : Promise.resolve(this.dirs);
}

const HOUR = 3_600_000;
const SESSIONS: SessionSummary[] = Array.from({ length: 10 }, (_, i) => ({
  id: `sess${String(i)}0000000000`,
  cwd: `/srv/proj-${String(i)}`,
  createdAt: Date.now() - (i + 1) * HOUR,
  modified: Date.now() - (i + 1) * HOUR,
  title: i === 0 ? "Fix the parser so that the benchmark suite passes again" : undefined,
}));

class FakeHandoff implements PanelHandoff {
  sessions: SessionSummary[] | Error = SESSIONS;
  refuse: Error | undefined;
  readonly continued: [ConversationKey, string][] = [];
  unbound = (limit: number): Promise<SessionSummary[]> =>
    this.sessions instanceof Error ? Promise.reject(this.sessions) : Promise.resolve(this.sessions.slice(0, limit));
  continueHere = (key: ConversationKey, sessionId: string): Promise<void> => {
    if (this.refuse) return Promise.reject(this.refuse);
    this.continued.push([key, sessionId]);
    control.current = status({ sessionId, cwd: "/srv/proj-0" });
    return Promise.resolve();
  };
}

let store: ChannelStore;
let control: FakeControl;
let handoff: FakeHandoff;
let logs: string[];

beforeEach(() => {
  const vault = new Map<string, string>();
  store = new ChannelStore(openDb(":memory:"), { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  control = new FakeControl();
  handoff = new FakeHandoff();
  logs = [];
});

// --- Slack -----------------------------------------------------------------------

class FakeSlack {
  readonly posted: Record<string, unknown>[] = [];
  readonly updated: Record<string, unknown>[] = [];
  readonly views: unknown[] = [];

  postMessage = (payload: Record<string, unknown>): Promise<{ ts: string }> => {
    this.posted.push(payload);
    return Promise.resolve({ ts: "1717.0001" });
  };
  updateMessage = (payload: Record<string, unknown>): Promise<void> => {
    this.updated.push(payload);
    return Promise.resolve();
  };
  deleteMessage = (): Promise<void> => Promise.resolve();
  openView = (_trigger: string, view: unknown): Promise<void> => {
    this.views.push(view);
    return Promise.resolve();
  };
}

const SLACK_KEY: ConversationKey = { channelId: "slack", conversationId: "s1" };

const slackPanel = (api: FakeSlack): SlackPanel =>
  new SlackPanel({
    api: api as unknown as Pick<
      SlackClient,
      "postMessage" | "updateMessage" | "deleteMessage" | "openView"
    >,
    control,
    handoff,
    store,
    log: (m) => logs.push(m),
  });

const text = (block: SlackBlock): string =>
  (block as { text?: { text?: string } }).text?.text ?? "";
/** The panel's note is a context block under the buttons. */
const footnote = (block: SlackBlock): string =>
  (block as { elements?: { text?: string }[] }).elements?.[0]?.text ?? "";
const labels = (block: SlackBlock): string[] =>
  ((block as { elements?: { text?: { text: string } }[] }).elements ?? [])
    .map((e) => e.text?.text ?? "");

describe("slack panel", () => {
  it("renders one section per group and takes the button rows as authored", async () => {
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Session*");
    expect(text(blocks[0]!)).toContain("`01234567` · idle");
    expect(text(blocks[1]!)).toContain("*Channel*");
    expect(text(blocks[1]!)).toContain("mention on · bind on");
    expect(labels(blocks[2]!)).toEqual(["Model", "Reasoning"]);
    expect(labels(blocks[4]!)).toEqual(["Close"]);
  });

  it("no session: the group says how one starts and the chat line shows the defaults", async () => {
    control.current = null;
    control.launch = { cwd: "/srv/ops", model: MODELS[1], thinking: "medium" };
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("None in this thread yet");
    expect(text(blocks[0]!)).toContain("New session in…");
    expect(text(blocks[1]!)).toContain("New sessions start in `/srv/ops` · model-1 · reasoning medium");
  });

  it("offers Continue web session… only while the thread has no session", async () => {
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    expect(labels((api.posted[0]!.blocks as SlackBlock[])[3]!)).toEqual(["New session", "New session in…"]);
    control.current = null;
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    expect(labels((api.posted[1]!.blocks as SlackBlock[])[3]!))
      .toEqual(["New session", "New session in…", "Continue web session…"]);
  });

  it("no session and no chat config: the defaults line still says what would happen", async () => {
    control.current = null;
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[1]!)).toContain("New sessions start in Pier's directory · Pi default · default reasoning");
  });

  it("reasoning pick with no session prints NO_SESSION, not a confirmation", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    control.current = null;
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:think:high");
    const blocks = api.updated.at(-1)!.blocks as SlackBlock[];
    const note = footnote(blocks.at(-1)!);
    expect(note).toContain(NO_SESSION);
    expect(note).not.toContain("Reasoning set");
  });

  it("an empty session reads \"created, no message yet\"", async () => {
    control.current = status({ empty: true, tokens: null });
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("`01234567` · created, no message yet");
    expect(text(blocks[0]!)).toContain("Context: empty — the first message you send runs here.");
  });

  it("puts a whole page of models on one row", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:models:0");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Model* · page 1/2");
    expect(labels(blocks[1]!)).toHaveLength(8);
    // The current model is ticked, not repeated elsewhere.
    expect(labels(blocks[1]!)[0]).toBe("✓ model-0");
    expect(labels(blocks[2]!)).toEqual(["Next ›", "‹ Back"]);
  });

  it("New session in… lists recent directories as buttons with numbered full paths", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*New session in*");
    expect(text(blocks[0]!)).toContain("1. `/home/qiqi/code/dev/pier`");
    expect(text(blocks[0]!)).toContain("2. `/srv/ops`");
    expect(labels(blocks[1]!)).toEqual(["1 …/dev/pier", "2 /srv/ops"]);
    expect(labels(blocks[2]!)).toEqual(["Type a path…", "‹ Back"]);
    expect(api.views).toEqual([]);
  });

  it("cwd:<i> creates there and the note distinguishes created from run", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd:1");
    expect(control.newSessions).toEqual(["/srv/ops"]);
    const note = footnote((api.updated.at(-1)!.blocks as SlackBlock[]).at(-1)!);
    expect(note).toContain("Created session abcdef01 in /srv/ops");
    expect(note).toContain("nothing has run yet");
  });

  it("a stale index after a redraw is refused, not misfiled", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd:7");
    expect(control.newSessions).toEqual([]);
    expect(footnote((api.updated.at(-1)!.blocks as SlackBlock[]).at(-1)!)).toBe("That directory is no longer listed.");
  });

  it("empty listing offers only the typed path", async () => {
    control.dirs = [];
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("No sessions yet — type a path.");
    expect(blocks).toHaveLength(2);
    expect(labels(blocks[1]!)).toEqual(["Type a path…", "‹ Back"]);
  });

  it("a listing that fails says so and still offers the typed path", async () => {
    control.dirs = new Error("disk");
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:cwd");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("Could not list recent directories: Error: disk");
    expect(labels(blocks[1]!)).toEqual(["Type a path…", "‹ Back"]);
  });

  it("Type a path… opens the modal carrying the conversation", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({ trigger_id: "t1" } as SlackInteraction, SLACK_KEY, "cfg:cwdtype");
    expect(api.views[0]).toMatchObject({ callback_id: "cfg_cwd", private_metadata: "s1" });
    expect(JSON.stringify(api.views[0])).toContain("\"Create\"");
  });

  it("starts the session a submitted modal asked for", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    const submission = {
      view: {
        callback_id: "cfg_cwd",
        private_metadata: "s1",
        state: { values: { cwd_block: { cwd_input: { value: "/srv/other" } } } },
      },
    } as unknown as SlackInteraction;
    expect(await panel.onViewSubmission(submission)).toBe(true);
    expect(control.newSessions).toEqual(["/srv/other"]);
  });

  it("leaves a submission from someone else's view alone", async () => {
    const panel = slackPanel(new FakeSlack());
    const other = { view: { callback_id: "other" } } as unknown as SlackInteraction;
    expect(await panel.onViewSubmission(other)).toBe(false);
  });
});

describe("continue web session picker", () => {
  const openPicker = async (page = "0"): Promise<{ api: FakeSlack; panel: SlackPanel }> => {
    control.current = null;
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, `cfg:sessions:${page}`);
    return { api, panel };
  };

  it("lists eight per page: title or directory, basename, age; picks by index", async () => {
    const { api } = await openPicker();
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Continue web session* · page 1/2");
    expect(text(blocks[0]!)).toContain("1. Fix the parser so that the benchmark su… · `proj-0` · 1h");
    expect(text(blocks[0]!)).toContain("2. proj-1 · `proj-1` · 2h");
    expect(text(blocks[0]!)).toContain("8. proj-7 · `proj-7` · 8h");
    expect(text(blocks[0]!)).not.toContain("9. ");
    const picks = labels(blocks[1]!);
    expect(picks).toHaveLength(8);
    expect(picks[0]).toBe("1 Fix the parser so that the benchmark su…");
    expect(picks[7]).toBe("8 proj-7");
    expect(labels(blocks[2]!)).toEqual(["Next ›", "‹ Back"]);
  });

  it("pages: the second page continues the numbering and offers Prev", async () => {
    const { api } = await openPicker("1");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("page 2/2");
    expect(text(blocks[0]!)).toContain("9. proj-8");
    expect(labels(blocks[1]!)).toEqual(["9 proj-8", "10 proj-9"]);
    expect(labels(blocks[2]!)).toEqual(["‹ Prev", "‹ Back"]);
  });

  it("a pick binds this thread through the handoff and the panel shows the session", async () => {
    const { api, panel } = await openPicker("1");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:session:9");
    expect(handoff.continued).toEqual([[SLACK_KEY, "sess90000000000"]]);
    expect(control.newSessions).toEqual([]);
    const blocks = api.updated.at(-1)!.blocks as SlackBlock[];
    expect(footnote(blocks.at(-1)!)).toBe("Continuing session sess9000 — reply in this thread.");
    expect(text(blocks[0]!)).toContain("`sess9000` · idle");
    expect(labels(blocks[3]!)).toEqual(["New session", "New session in…"]);
  });

  it("an empty list says so and offers only Back", async () => {
    handoff.sessions = [];
    const { api } = await openPicker();
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("No unbound sessions.");
    expect(blocks).toHaveLength(2);
    expect(labels(blocks[1]!)).toEqual(["‹ Back"]);
  });

  it("a listing that fails is not drawn as empty", async () => {
    handoff.sessions = new Error("disk");
    const { api } = await openPicker();
    expect(text((api.updated[0]!.blocks as SlackBlock[])[0]!)).toContain("Could not list sessions: Error: disk");
    expect(logs).toContain("Could not list sessions: Error: disk");
  });

  it("a pick that lost the race prints the guard's refusal, never silence", async () => {
    handoff.refuse = new HandoffError(409, "Already answers in lark · DM · Qi.");
    const { api, panel } = await openPicker();
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:session:0");
    const blocks = api.updated.at(-1)!.blocks as SlackBlock[];
    expect(footnote(blocks.at(-1)!)).toBe("Already answers in lark · DM · Qi.");
    expect(text(blocks[0]!)).toContain("None in this thread yet");
  });

  it("a failure that is not a refusal names what was attempted", async () => {
    handoff.refuse = new Error("SQLITE_BUSY");
    const { api, panel } = await openPicker();
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:session:0");
    expect(footnote((api.updated.at(-1)!.blocks as SlackBlock[]).at(-1)!))
      .toBe("Could not continue that session: Error: SQLITE_BUSY");
  });

  it("a stale index is refused, not misfiled", async () => {
    const { api, panel } = await openPicker();
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:session:42");
    expect(handoff.continued).toEqual([]);
    expect(footnote((api.updated.at(-1)!.blocks as SlackBlock[]).at(-1)!)).toBe("That session is no longer listed.");
  });
});

