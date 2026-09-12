// The settings panel, through Slack's rendering of the shared behaviour.
// Hermetic — a recording control, a fake client.

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentLaunchOptions, ConversationKey, ModelRef, SessionSummary, ThinkingLevel } from "../core/types.js";
import type { ModelMenuEntry } from "../settings.js";
import { type ChannelControl, type ConversationStatus, HAS_SESSION } from "./control.js";
import { HandoffError } from "./handoff.js";
import { type PanelHandoff, QUESTION_TOO_LONG } from "./panel.js";
import { SlackPanel } from "./slack-panel.js";
import type { SlackBlock, SlackClient, SlackInteraction } from "./slack-api.js";

const ref = (i: number): ModelRef => ({ provider: "anthropic", id: `model-${i}` });
/** Ten pins: the last repeats the first's model at another level, so a tick
 *  that ignored the level would show twice. */
const PINS: ModelMenuEntry[] = Array.from({ length: 10 }, (_, i) => ({
  ...ref(i === 9 ? 0 : i),
  thinking: (i === 0 ? "off" : "high") as ThinkingLevel,
  ...(i === 1 ? {} : { note: `note-${i}` }),
}));

const status = (over: Partial<ConversationStatus> = {}): ConversationStatus => ({
  sessionId: "0123456789abcdef",
  cwd: "/srv/pier",
  state: "idle",
  empty: false,
  model: ref(0),
  thinking: "off",
  tokens: 1200,
  contextWindow: 200_000,
  ...over,
});

/** `current` is the thread's session; null is a thread without one, and
 *  `knows` agrees, as the real control's row does. */
class FakeControl implements ChannelControl {
  current: ConversationStatus | null = status();
  readonly newSessions: Partial<AgentLaunchOptions>[] = [];
  dirs: string[] | Error = ["/home/qiqi/code/dev/pier", "/srv/ops"];
  pinned: ModelMenuEntry[] = PINS;
  readonly setModels: ModelRef[] = [];
  readonly setLevels: ThinkingLevel[] = [];
  aborted = 0;
  launch: Partial<AgentLaunchOptions> = {};
  launchFor = (): Partial<AgentLaunchOptions> => this.launch;
  knows = (): boolean => this.current !== null;
  abort = (): Promise<void> => {
    this.aborted++;
    return Promise.resolve();
  };
  status = (): Promise<ConversationStatus | null> => Promise.resolve(this.current);
  pins = (): ModelMenuEntry[] => this.pinned;
  setModel = (_k: ConversationKey, model: ModelRef): Promise<void> => {
    this.setModels.push(model);
    return Promise.resolve();
  };
  setThinking = (_k: ConversationKey, level: ThinkingLevel): Promise<void> => {
    this.setLevels.push(level);
    return Promise.resolve();
  };
  newSession = (_k: ConversationKey, over: Partial<AgentLaunchOptions> = {}): Promise<string> => {
    this.newSessions.push(over);
    this.current = status({
      sessionId: "abcdef0123456789",
      cwd: over.cwd ?? this.launch.cwd ?? "/srv/pier",
      model: over.model ?? this.launch.model,
      thinking: over.thinking ?? this.launch.thinking ?? "off",
      empty: true,
      tokens: null,
    });
    return Promise.resolve("abcdef0123456789");
  };
  recentDirs = (): Promise<string[]> =>
    this.dirs instanceof Error ? Promise.reject(this.dirs) : Promise.resolve(this.dirs);
  exchanges: { user: string; assistant?: string }[] | Error = [];
  recent = (_k: ConversationKey, count: number): Promise<{ user: string; assistant?: string }[]> =>
    this.exchanges instanceof Error ? Promise.reject(this.exchanges) : Promise.resolve(this.exchanges.slice(-count));
}

/** Two exchanges as they are stored: a speaker header, an attachment marker,
 *  a next-step block, a silent turn's reason. */
const EXCHANGES: { user: string; assistant?: string }[] = [
  {
    user: "[Qi<U42> 14:23 slack:C100/1717.0000]\nread the\nparser\n[notes.md](file:///srv/notes.md)",
    assistant: "<silent>not for me</silent>Read it.\n\n---\n[Run it] | [Show the diff]",
  },
  { user: "[14:31]\nand fix it", assistant: `Fixed ${"y".repeat(200)}` },
];

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

let control: FakeControl;
let handoff: FakeHandoff;
let logs: string[];
let ran: string[];

beforeEach(() => {
  control = new FakeControl();
  handoff = new FakeHandoff();
  logs = [];
  ran = [];
});

// --- Slack -----------------------------------------------------------------------

class FakeSlack {
  readonly posted: Record<string, unknown>[] = [];
  readonly updated: Record<string, unknown>[] = [];
  readonly deleted: string[] = [];
  readonly views: unknown[] = [];

  postMessage = (payload: Record<string, unknown>): Promise<{ ts: string }> => {
    this.posted.push(payload);
    return Promise.resolve({ ts: "1717.0001" });
  };
  updateMessage = (payload: Record<string, unknown>): Promise<void> => {
    this.updated.push(payload);
    return Promise.resolve();
  };
  deleteMessage = (_channel: string, ts: string): Promise<void> => {
    this.deleted.push(ts);
    return Promise.resolve();
  };
  openView = (_trigger: string, view: unknown): Promise<void> => {
    this.views.push(view);
    return Promise.resolve();
  };
}

const SLACK_KEY: ConversationKey = { channelId: "slack", conversationId: "C100/1717.0000" };

const slackPanel = (api: FakeSlack): SlackPanel =>
  new SlackPanel({
    api: api as unknown as Pick<
      SlackClient,
      "postMessage" | "updateMessage" | "deleteMessage" | "openView"
    >,
    control,
    handoff,
    log: (m) => logs.push(m),
  });

const tap = (panel: SlackPanel, action: string, interaction: Partial<SlackInteraction> = {}): Promise<boolean> =>
  panel.onAction(interaction as SlackInteraction, SLACK_KEY, action, (text) => {
    ran.push(text);
    return Promise.resolve();
  });

const text = (block: SlackBlock): string =>
  (block as { text?: { text?: string } }).text?.text ?? "";
/** The panel's note is a context block under the buttons. */
const footnote = (block: SlackBlock): string =>
  (block as { elements?: { text?: string }[] }).elements?.[0]?.text ?? "";
const labels = (block: SlackBlock): string[] =>
  ((block as { elements?: { text?: { text: string } }[] }).elements ?? [])
    .map((e) => e.text?.text ?? "");
/** Every button's value across the message, parsed; `undefined` where a button has none. */
const values = (blocks: SlackBlock[]): unknown[] =>
  blocks.filter((b) => b.type === "actions").flatMap((b) =>
    (b as { elements: { value?: string }[] }).elements.map((e) => e.value === undefined ? undefined : JSON.parse(e.value)));
const last = (api: FakeSlack): SlackBlock[] => api.updated.at(-1)!.blocks as SlackBlock[];
/** A panel opened in the thread, `question` making it the draft's trigger. */
const opened = async (question?: string): Promise<{ api: FakeSlack; panel: SlackPanel }> => {
  const api = new FakeSlack();
  const panel = slackPanel(api);
  await panel.open(SLACK_KEY, "C100", "1717.0000", question);
  return { api, panel };
};

describe("the Recent group", () => {
  /** The Recent section of the card as last drawn. */
  const recent = (blocks: SlackBlock[]): string => text(blocks[1]!);
  /** Only one card carries it: the one Continue web session… settles on. */
  const continued = async (): Promise<SlackBlock[]> => {
    control.current = null;
    const { api, panel } = await opened();
    await tap(panel, "cfg:sessions:0");
    await tap(panel, "cfg:session:0");
    return last(api);
  };

  it("excerpts the last two exchanges, oldest first, stripped, flattened and cut", async () => {
    control.exchanges = EXCHANGES;
    const blocks = await continued();
    const lines = recent(blocks).split("\n");
    expect(lines[0]).toBe("*Recent*");
    expect(lines[1]).toBe("▸ read the parser");
    expect(lines[2]).toBe("◂ Read it.");
    expect(lines[3]).toBe("▸ and fix it");
    expect(lines[4]).toBe(`◂ Fixed ${"y".repeat(143)}…`);
    expect(lines[4]!.length).toBe(152);
    expect(recent(blocks)).not.toContain("Run it");
    expect(recent(blocks)).not.toContain("not for me");
    expect(recent(blocks)).not.toContain("file://");
    expect(recent(blocks)).not.toContain("U42");
  });

  it("asks for two and shows one when that is all there is", async () => {
    control.exchanges = [EXCHANGES[1]!];
    expect(recent(await continued()).split("\n")).toHaveLength(3);
  });

  it("an unanswered last turn is a ▸ without a ◂", async () => {
    control.exchanges = [{ user: "still thinking?" }];
    expect(recent(await continued())).toBe("*Recent*\n▸ still thinking?");
  });

  it("a session with no turn yet has no group at all", async () => {
    const blocks = await continued();
    expect(JSON.stringify(blocks)).not.toContain("Recent");
    expect(blocks).toHaveLength(2);
  });

  it("a read that fails says so on the card and is logged", async () => {
    control.exchanges = new Error("disk");
    expect(recent(await continued()))
      .toBe("*Recent*\nCould not read the transcript: Error: disk");
    expect(logs).toContain("Could not read the transcript: Error: disk");
  });

  it("the draft view has none: there is no transcript to excerpt", async () => {
    control.current = null;
    control.exchanges = EXCHANGES;
    const { api } = await opened();
    expect(JSON.stringify(api.posted[0]!.blocks)).not.toContain("Recent");
  });

  it("the panel of a thread with a session has none: the conversation is right above it", async () => {
    control.exchanges = EXCHANGES;
    const { api } = await opened();
    expect(JSON.stringify(api.posted[0]!.blocks)).not.toContain("Recent");
  });

  it("Start settles without it: the session it created has no conversation yet", async () => {
    control.current = null;
    control.exchanges = EXCHANGES;
    const { api, panel } = await opened();
    await tap(panel, "cfg:start");
    expect(JSON.stringify(last(api))).not.toContain("Recent");
  });
});

describe("slack panel with a session", () => {
  it("says in the thread when the card itself cannot be posted", async () => {
    const api = new FakeSlack();
    const post = api.postMessage;
    let first = true;
    api.postMessage = (payload) => {
      if (!first) return post(payload);
      first = false;
      return Promise.reject(new Error("invalid_blocks"));
    };
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000", undefined);
    // Plain text, in the same thread: nothing that happened may look like nothing.
    expect(api.posted).toEqual([{
      channel: "C100",
      thread_ts: "1717.0000",
      text: "Could not open the panel: Error: invalid_blocks",
    }]);
    expect(logs).toContain("panel open failed: Error: invalid_blocks");
  });

  it("reads the session out and offers one button; no channel group, no New session, no Close", async () => {
    const { api } = await opened();
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(blocks).toHaveLength(2);
    expect(text(blocks[0]!)).toContain("*Session*");
    expect(text(blocks[0]!)).toContain("`01234567` · idle");
    expect(labels(blocks[1]!)).toEqual(["Model & reasoning"]);
    expect(JSON.stringify(blocks)).not.toContain("Channel");
    expect(JSON.stringify(blocks)).not.toContain("New session");
    expect(JSON.stringify(blocks)).not.toContain("Close");
    expect(values(blocks)).toEqual([undefined]);
  });

  it("offers Stop while streaming", async () => {
    control.current = status({ state: "streaming" });
    const { api } = await opened();
    expect(labels((api.posted[0]!.blocks as SlackBlock[])[1]!)).toEqual(["Model & reasoning", "⏹ Stop"]);
  });

  it("an empty session reads \"created, no message yet\"", async () => {
    control.current = status({ empty: true, tokens: null });
    const { api } = await opened();
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("`01234567` · created, no message yet");
    expect(text(blocks[0]!)).toContain("Context: empty — the first message you send runs here.");
  });

  it("lists the operator's pins eight a page, the current model and level ticked", async () => {
    const { api, panel } = await opened();
    await tap(panel, "cfg:pins:0");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Model & reasoning* · page 1/2");
    expect(text(blocks[0]!)).toContain("1. ✓ model-0 · Off — note-0");
    // A pin with no note stops after the level.
    expect(text(blocks[0]!)).toContain("2. model-1 · High\n");
    expect(text(blocks[0]!)).toContain("8. model-7 · High — note-7");
    expect(text(blocks[0]!)).not.toContain("9. ");
    expect(labels(blocks[1]!)).toHaveLength(8);
    expect(labels(blocks[1]!)[0]).toBe("1 model-0");
    expect(labels(blocks[2]!)).toEqual(["Next ›", "‹ Back"]);
  });

  it("pages: the numbering continues and the same model at another level is not ticked", async () => {
    const { api, panel } = await opened();
    await tap(panel, "cfg:pins:1");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("page 2/2");
    expect(text(blocks[0]!)).toContain("10. model-0 · High — note-9");
    expect(text(blocks[0]!)).not.toContain("✓");
    expect(labels(blocks[1]!)).toEqual(["9 model-8", "10 model-0"]);
    expect(labels(blocks[2]!)).toEqual(["‹ Prev", "‹ Back"]);
  });

  it("a pick sets the model and the level together and redraws the same one button", async () => {
    const { api, panel } = await opened();
    await tap(panel, "cfg:pins:0");
    await tap(panel, "cfg:pin:1");
    expect(control.setModels).toEqual([{ provider: "anthropic", id: "model-1" }]);
    expect(control.setLevels).toEqual(["high"]);
    expect(footnote(last(api).at(-1)!)).toBe("Model set to model-1 · High.");
    expect(labels(last(api)[1]!)).toEqual(["Model & reasoning"]);
    expect(api.posted).toHaveLength(1);
  });

  it("no pins: the empty list names where they are pinned", async () => {
    control.pinned = [];
    const { api, panel } = await opened();
    await tap(panel, "cfg:pins:0");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("No pinned models — Settings → Models → Model menu.");
    expect(blocks).toHaveLength(2);
    expect(labels(blocks[1]!)).toEqual(["‹ Back"]);
  });

  it("a stale pin index is refused, not misfiled", async () => {
    const { api, panel } = await opened();
    await tap(panel, "cfg:pin:42");
    expect(control.setModels).toEqual([]);
    expect(control.setLevels).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe("That model is no longer listed.");
  });

  it("a directory tap on this thread changes nothing and says why", async () => {
    const { api, panel } = await opened();
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:1");
    expect(control.newSessions).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe(HAS_SESSION);
  });

  it("leaves a submission from someone else's view alone", async () => {
    const panel = slackPanel(new FakeSlack());
    const other = { view: { callback_id: "other" } } as unknown as SlackInteraction;
    expect(await panel.onViewSubmission(other)).toBe(false);
  });
});

describe("draft panel (no session in the thread)", () => {
  const openDraft = (question?: string): Promise<{ api: FakeSlack; panel: SlackPanel }> => {
    control.current = null;
    control.launch = { cwd: "/srv/ops", model: ref(1), thinking: "medium" };
    return opened(question);
  };

  it("is seeded from the chat defaults and says so; Start replaces New session", async () => {
    const { api } = await openDraft();
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toBe("*Session* · chat defaults\nStarts in `/srv/ops` · model-1 · reasoning medium");
    expect(labels(blocks[1]!)).toEqual(["Model & reasoning", "Directory…", "Continue web session…"]);
    expect(labels(blocks[2]!)).toEqual(["Start", "Close"]);
    expect(JSON.stringify(blocks)).not.toContain("New session");
    // Nothing chosen: nothing to carry.
    expect(values(blocks).every((v) => v === undefined)).toBe(true);
  });

  it("no chat config: the line still says what Start would do", async () => {
    control.current = null;
    const { api } = await opened();
    expect(text((api.posted[0]!.blocks as SlackBlock[])[0]!)).toContain("Starts in Pier's directory · Pi default · default reasoning");
  });

  it("shows the pending question, flattened and cut, and carries it whole on every button", async () => {
    const q = `Please review\nthe parser ${"x".repeat(100)}`;
    const { api } = await openDraft(q);
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    const line = text(blocks[0]!).split("\n")[2]!;
    expect(line.startsWith("▸ Please review the parser xxx")).toBe(true);
    expect(line.length).toBe(82);
    expect(values(blocks)).toEqual(Array<unknown>(5).fill({ q }));
  });

  it("a Model & reasoning pick sets the draft, ticks it, and rides every button", async () => {
    const { api, panel } = await openDraft("go");
    await tap(panel, "cfg:pins:0");
    // The chat default is model-1 · medium; the pin is model-1 · high, so nothing is ticked yet.
    expect(text((api.updated[0]!.blocks as SlackBlock[])[0]!)).not.toContain("✓");
    await tap(panel, "cfg:pin:1");
    expect(control.setModels).toEqual([]);
    const blocks = last(api);
    expect(text(blocks[0]!)).toBe("*Session*\nStarts in `/srv/ops` · model-1 · reasoning high\n▸ go");
    const draft = { model: { provider: "anthropic", id: "model-1" }, thinking: "high", q: "go" };
    expect(values(blocks)).toEqual(Array<unknown>(5).fill(draft));
    await tap(panel, "cfg:pins:0");
    expect(text(last(api)[0]!)).toContain("2. ✓ model-1 · High");
  });

  it("Directory… lists recent directories as buttons with numbered full paths", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwd");
    const blocks = last(api);
    expect(text(blocks[0]!)).toContain("*Directory*");
    expect(text(blocks[0]!)).toContain("1. `/home/qiqi/code/dev/pier`");
    expect(text(blocks[0]!)).toContain("2. `/srv/ops`");
    expect(labels(blocks[1]!)).toEqual(["1 …/dev/pier", "2 /srv/ops"]);
    expect(labels(blocks[2]!)).toEqual(["Type a path…", "‹ Back"]);
    expect(api.views).toEqual([]);
  });

  it("empty listing offers only the typed path", async () => {
    control.dirs = [];
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwd");
    const blocks = last(api);
    expect(text(blocks[0]!)).toContain("No sessions yet — type a path.");
    expect(blocks).toHaveLength(2);
    expect(labels(blocks[1]!)).toEqual(["Type a path…", "‹ Back"]);
  });

  it("a listing that fails says so and still offers the typed path", async () => {
    control.dirs = new Error("disk");
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwd");
    const blocks = last(api);
    expect(text(blocks[0]!)).toContain("Could not list recent directories: Error: disk");
    expect(labels(blocks[1]!)).toEqual(["Type a path…", "‹ Back"]);
  });

  it("a stale index after a redraw is refused, not misfiled", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:7");
    expect(control.newSessions).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe("That directory is no longer listed.");
  });

  it("a pick sets the draft's directory without creating anything", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:1");
    expect(control.newSessions).toEqual([]);
    expect(text(last(api)[0]!)).toContain("Starts in `/srv/ops` · model-1 · reasoning medium");
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:0");
    expect(text(last(api)[0]!)).toBe("*Session*\nStarts in `/home/qiqi/code/dev/pier` · model-1 · reasoning medium");
    expect(values(last(api))).toEqual(Array<unknown>(5).fill({ cwd: "/home/qiqi/code/dev/pier" }));
  });

  it("a typed path sets the draft too, and the modal says so", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:cwdtype", { trigger_id: "t1" });
    const view = api.views[0] as { callback_id: string; private_metadata: string };
    expect(view.callback_id).toBe("cfg_cwd");
    expect(JSON.parse(view.private_metadata)).toEqual({ conversation: "C100/1717.0000", ts: "1717.0001" });
    expect(JSON.stringify(api.views[0])).toContain("Start creates the session there.");
    expect(JSON.stringify(api.views[0])).toContain("\"Set\"");
    await panel.onViewSubmission({
      view: {
        callback_id: "cfg_cwd",
        private_metadata: JSON.stringify({ conversation: "C100/1717.0000", ts: "1717.0001" }),
        state: { values: { cwd_block: { cwd_input: { value: "/srv/typed" } } } },
      },
    } as unknown as SlackInteraction);
    expect(control.newSessions).toEqual([]);
    expect(text(last(api)[0]!)).toContain("Starts in `/srv/typed`");
  });

  it("Start without a question creates with the draft and settles the card on the session", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:pin:2");
    await tap(panel, "cfg:start");
    expect(control.newSessions).toEqual([{ model: ref(2), thinking: "high" }]);
    expect(ran).toEqual([]);
    const blocks = last(api);
    expect(blocks).toHaveLength(2);
    expect(footnote(blocks.at(-1)!)).toBe("Started abcdef01 in /srv/ops.");
    expect(text(blocks[0]!)).toContain("`abcdef01` · created, no message yet");
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("the settled card is released: a later tap answers on it, posting nothing new", async () => {
    const { api, panel } = await openDraft();
    await tap(panel, "cfg:start");
    const drawn = api.updated.length;
    await tap(panel, "cfg:pin:99");
    expect(api.posted).toHaveLength(1);
    expect(api.updated.length).toBe(drawn + 1);
    expect(footnote(last(api).at(-1)!)).toBe("That model is no longer listed.");
    expect(control.newSessions).toHaveLength(1);
    expect(labels(last(api)[1]!)).toEqual(["Model & reasoning"]);
  });

  it("a draft-only page is refused on a card whose thread has since gained a session", async () => {
    const { api, panel } = await openDraft();
    control.current = status();
    for (const action of ["cfg:cwd", "cfg:cwdtype", "cfg:sessions:0", "cfg:session:0"]) {
      await tap(panel, action);
      expect(footnote(last(api).at(-1)!)).toBe(HAS_SESSION);
      // The with-session card is what is drawn, never a list of refused picks.
      expect(labels(last(api)[1]!)).toEqual(["Model & reasoning"]);
    }
    expect(api.views).toEqual([]);
    expect(handoff.continued).toEqual([]);
  });

  it("Start with a question creates, then runs the question once", async () => {
    const { api, panel } = await openDraft("fix the parser");
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:1");
    await tap(panel, "cfg:start");
    expect(control.newSessions).toEqual([{ cwd: "/srv/ops" }]);
    expect(ran).toEqual(["fix the parser"]);
    expect(footnote(last(api).at(-1)!)).toBe("Started abcdef01 — running your question.");
    expect(JSON.stringify(last(api))).not.toContain("fix the parser");
  });

  it("Start after a message raced it does not replace the thread's session", async () => {
    const { api, panel } = await openDraft("go");
    control.current = status();
    await tap(panel, "cfg:start");
    expect(control.newSessions).toEqual([]);
    expect(ran).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe(HAS_SESSION);
    expect(text(last(api)[0]!)).toContain("`01234567` · idle");
  });

  it("a creation that fails is reported on the card", async () => {
    const { api, panel } = await openDraft("go");
    control.newSession = () => Promise.reject(new Error("no such directory"));
    await tap(panel, "cfg:start");
    expect(ran).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe("Could not start a session: Error: no such directory");
  });

  it("a race the control caught is the refusal sentence alone, not a failure report", async () => {
    const { api, panel } = await openDraft("go");
    control.newSession = () => Promise.reject(new Error(HAS_SESSION));
    await tap(panel, "cfg:start");
    expect(ran).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe(HAS_SESSION);
  });

  it("a question too long to hold is not held, and the card says so", async () => {
    // Measured as the button carries it: 900 quotes are 1808 serialized characters.
    const { api, panel } = await openDraft('"'.repeat(900));
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain(QUESTION_TOO_LONG);
    expect(values(blocks)).toEqual(Array<unknown>(5).fill({ dropped: true }));
    await tap(panel, "cfg:start");
    expect(control.newSessions).toEqual([{}]);
    expect(ran).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe("Started abcdef01 in /srv/ops.");
  });

  it("a held question keeps every button value inside Slack's 2000 characters, picks included", async () => {
    // Quotes double under JSON: what the user typed is not what the button carries.
    const { api, panel } = await openDraft('"'.repeat(840));
    expect(text((api.posted[0]!.blocks as SlackBlock[])[0]!)).not.toContain(QUESTION_TOO_LONG);
    await tap(panel, "cfg:pin:2");
    await tap(panel, "cfg:cwd");
    await tap(panel, "cfg:cwd:0");
    const carried = (last(api).filter((b) => b.type === "actions") as { elements: { value?: string }[] }[])
      .flatMap((b) => b.elements.map((e) => e.value ?? ""));
    expect(carried.length).toBeGreaterThan(0);
    expect(Math.max(...carried.map((v) => v.length))).toBeLessThanOrEqual(2000);
    expect(JSON.parse(carried[0]!)).toMatchObject({ q: '"'.repeat(840), cwd: "/home/qiqi/code/dev/pier" });
  });

  it("truncates a button label Slack would refuse", async () => {
    control.current = null;
    control.dirs = [`/srv/${"deep-".repeat(20)}project`];
    const { api, panel } = await opened();
    await tap(panel, "cfg:cwd");
    const picks = labels(last(api)[1]!);
    expect(picks[0]!.length).toBe(75);
    expect(picks[0]!.endsWith("\u2026")).toBe(true);
  });

  it("Continue web session… discards the draft", async () => {
    const { api, panel } = await openDraft("go");
    await tap(panel, "cfg:pin:2");
    await tap(panel, "cfg:sessions:0");
    await tap(panel, "cfg:session:0");
    expect(handoff.continued).toEqual([[SLACK_KEY, "sess00000000000"]]);
    expect(control.newSessions).toEqual([]);
    expect(ran).toEqual([]);
    expect(values(last(api)).every((v) => v === undefined)).toBe(true);
  });

  describe("after a restart", () => {
    const draft = { cwd: "/srv/kept", model: ref(3), thinking: "low", q: "still here" };
    const click = (action: string, value: unknown = draft): Partial<SlackInteraction> => ({
      channel: { id: "C100" },
      message: { ts: "900.0001", thread_ts: "1717.0000" },
      actions: [{ action_id: action, value: JSON.stringify(value) }],
    });

    it("rebuilds the draft from the tapped value and redraws in place, posting nothing", async () => {
      control.current = null;
      const api = new FakeSlack();
      const panel = slackPanel(api);
      await tap(panel, "cfg:panel", click("cfg:panel"));
      expect(api.posted).toEqual([]);
      expect(api.updated).toHaveLength(1);
      expect(api.updated[0]).toMatchObject({ channel: "C100", ts: "900.0001" });
      expect(text(last(api)[0]!)).toBe("*Session*\nStarts in `/srv/kept` · model-3 · reasoning low\n▸ still here");
      expect(values(last(api))).toEqual(Array<unknown>(5).fill(draft));
    });

    it("honours the tap itself: Start creates with the recovered draft and runs the question", async () => {
      control.current = null;
      const api = new FakeSlack();
      await tap(slackPanel(api), "cfg:start", click("cfg:start"));
      expect(control.newSessions).toEqual([{ cwd: "/srv/kept", model: ref(3), thinking: "low" }]);
      expect(ran).toEqual(["still here"]);
      expect(api.posted).toEqual([]);
    });

    it("Close deletes the card it was tapped on", async () => {
      const api = new FakeSlack();
      await tap(slackPanel(api), "cfg:close", click("cfg:close"));
      expect(api.deleted).toEqual(["900.0001"]);
    });

    it("an unreadable value is logged, drawn as an empty draft, and said once", async () => {
      control.current = null;
      const api = new FakeSlack();
      const panel = slackPanel(api);
      await tap(panel, "cfg:panel", {
        ...click("cfg:panel"),
        actions: [{ action_id: "cfg:panel", value: "{not json" }],
      });
      expect(logs.some((m) => m.startsWith("unreadable panel value"))).toBe(true);
      expect(text(last(api)[0]!)).toContain("· chat defaults");
      expect(footnote(last(api).at(-1)!)).toBe("Your earlier picks could not be read — pick again.");
      await tap(panel, "cfg:panel");
      expect(last(api).at(-1)!.type).not.toBe("context");
    });

    it("a foreign shape keeps only the fields the draft knows", async () => {
      control.current = null;
      const api = new FakeSlack();
      await tap(slackPanel(api), "cfg:panel", click("cfg:panel", { cwd: 7, model: { id: "x" }, thinking: "bogus", q: "ok", extra: 1 }));
      expect(values(last(api))).toEqual(Array<unknown>(5).fill({ q: "ok" }));
    });

    it("a stale index pick is refused, and the panel still lands on the card", async () => {
      control.current = null;
      const api = new FakeSlack();
      await tap(slackPanel(api), "cfg:cwd:1", click("cfg:cwd:1"));
      expect(control.newSessions).toEqual([]);
      expect(footnote(last(api).at(-1)!)).toBe("That directory is no longer listed.");
      expect(api.updated[0]).toMatchObject({ ts: "900.0001" });
    });

    it("a typed path lands on the card the modal was opened from", async () => {
      control.current = null;
      const api = new FakeSlack();
      await slackPanel(api).onViewSubmission({
        view: {
          callback_id: "cfg_cwd",
          private_metadata: JSON.stringify({ conversation: "C100/1717.0000", ts: "900.0001", draft: JSON.stringify(draft) }),
          state: { values: { cwd_block: { cwd_input: { value: "/srv/typed" } } } },
        },
      } as unknown as SlackInteraction);
      expect(api.updated[0]).toMatchObject({ channel: "C100", ts: "900.0001" });
      expect(values(last(api))).toEqual(Array<unknown>(5).fill({ ...draft, cwd: "/srv/typed" }));
    });
  });
});

describe("continue web session picker", () => {
  const openPicker = async (page = "0"): Promise<{ api: FakeSlack; panel: SlackPanel }> => {
    control.current = null;
    const { api, panel } = await opened();
    await tap(panel, `cfg:sessions:${page}`);
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
    await tap(panel, "cfg:session:9");
    expect(handoff.continued).toEqual([[SLACK_KEY, "sess90000000000"]]);
    expect(control.newSessions).toEqual([]);
    const blocks = last(api);
    expect(footnote(blocks.at(-1)!)).toBe("Continuing session sess9000 — reply in this thread.");
    expect(text(blocks[0]!)).toContain("`sess9000` · idle");
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
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
    await tap(panel, "cfg:session:0");
    const blocks = last(api);
    expect(footnote(blocks.at(-1)!)).toBe("Already answers in lark · DM · Qi.");
    expect(text(blocks[0]!)).toContain("Starts in");
  });

  it("a failure that is not a refusal names what was attempted", async () => {
    handoff.refuse = new Error("SQLITE_BUSY");
    const { api, panel } = await openPicker();
    await tap(panel, "cfg:session:0");
    expect(footnote(last(api).at(-1)!)).toBe("Could not continue that session: Error: SQLITE_BUSY");
  });

  it("a stale index is refused, not misfiled", async () => {
    const { api, panel } = await openPicker();
    await tap(panel, "cfg:session:42");
    expect(handoff.continued).toEqual([]);
    expect(footnote(last(api).at(-1)!)).toBe("That session is no longer listed.");
  });
});
