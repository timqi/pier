// The in-chat settings panel, minus the platform: one message edited in place,
// every payload namespaced `cfg:` so a tap never reaches the agent. Choices
// travel as an index: platform callback payloads are small and opaque. A thread
// without a session shows a draft — cwd, model, reasoning, a pending question —
// that rides every button's value, so the card is the store and a restart
// loses nothing.

import { sessionLabel, splitSpeaker } from "../core/identity.js";
import { splitInboundFiles } from "../core/inbound-file.js";
import { compact, cut, splitReply, thinkingLabel } from "../core/reply.js";
import {
  type ConversationKey,
  isThinkingLevel,
  type ModelRef,
  type SessionSummary,
  type ThinkingLevel,
} from "../core/types.js";
import { type ChannelControl, type ConversationStatus, HAS_SESSION, NO_SESSION } from "./control.js";
import { type Handoff, HandoffError } from "./handoff.js";

export const PANEL_PREFIX = "cfg:";
const PER_PAGE = 8;
/** The picker's reach: five pages of the newest unbound sessions. */
const SESSIONS_LISTED = 40;
const TITLE_CHARS = 40;
const QUESTION_CHARS = 80;
/** Exchanges excerpted under the session, and the width of one line: four of
 *  these stay far inside Slack's 3000-character section. */
const RECENT_EXCHANGES = 2;
const EXCERPT_CHARS = 150;
/** Characters of the serialized draft — what a button actually carries. Slack
 *  caps a value at 2000 and Lark a card at 30 KB; the rest of the 2000 is room
 *  for the cwd, model and reasoning a pick adds after the question. */
const DRAFT_CHARS = 1700;

/** Pages whose every pick Pi's fixed-at-creation cwd or the row would refuse:
 *  reachable only by tapping a card that gained a session since it was drawn. */
const DRAFT_ONLY = new Set(["cwd", "cwdtype", "sessions", "session"]);

/** The pull half of the handoff; the push half never needs a panel. */
export type PanelHandoff = Pick<Handoff, "unbound" | "continueHere">;

export const CWD_DRAFT_TAIL = "Start creates the session there.";
export const CWD_PLACEHOLDER = "/path/to/project";
export const QUESTION_TOO_LONG = "Your question is too long to hold — send it again after Start.";

export interface PanelButton {
  label: string;
  /** Goes into the payload behind `PANEL_PREFIX`. */
  action: string;
}

/** A titled block of lines: one Slack section, one Lark markdown element. */
export interface PanelGroup {
  title: string;
  /** Trails the title outside the emphasis, for a counter or a hint. */
  suffix?: string;
  lines: string[];
}

export interface PanelView {
  groups: PanelGroup[];
  /** Same-kind choices, laid out by the platform as one row. */
  picks?: PanelButton[];
  /** Button rows, taken as authored. */
  rows: PanelButton[][];
}

/** What Start creates with, only the fields a pick set; the rest are the chat
 *  defaults at creation. Serialized into every button's value. */
export interface PanelDraft {
  cwd?: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  /** The pending question, run as the thread's first message on Start. */
  q?: string;
  /** The question was over QUESTION_BYTES and is not held. */
  dropped?: true;
}

export interface PanelDeps {
  control: ChannelControl;
  handoff: PanelHandoff;
  log(message: string): void;
}

export interface PanelState {
  draft: PanelDraft;
  /** The lists the payloads' indices point into. */
  dirs: string[];
  sessions: SessionSummary[];
}

const btn = (label: string, action: string): PanelButton => ({ label, action });

/** A button label is the last two segments; the numbered line above has the whole path. */
const shortDir = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

/** One transcript line as a reader sees it: what was said, minus what was
 *  written for the model (the speaker header, attachment markers, the
 *  next-step block, a silent turn's reason). */
const excerpt = (text: string, role: "user" | "assistant"): string => {
  const said = role === "user" ? splitInboundFiles(splitSpeaker(text).text).text : splitReply(text).text;
  return cut(said.replace(/\s+/g, " ").trim(), EXCERPT_CHARS);
};

const shortTitle = (s: SessionSummary): string => cut(sessionLabel(s), TITLE_CHARS);

/** Compact age, as the web sidebar spells it ("now", "12m", "3h", "2d"). */
const age = (ts: number, now: number): string => {
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${String(mins)}m`;
  if (mins < 1440) return `${String(Math.round(mins / 60))}h`;
  return `${String(Math.round(mins / 1440))}d`;
};

/** Page `page` of `items`, clamped: a stale Next past the end lands on the last page. */
const paged = <T>(items: T[], page: number): { at: number; pages: number; slice: T[]; from: number } => {
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const at = Math.min(Math.max(page, 0), pages - 1);
  const from = at * PER_PAGE;
  return { at, pages, slice: items.slice(from, from + PER_PAGE), from };
};

const pager = (action: string, at: number, pages: number): PanelButton[] => [
  ...(at > 0 ? [btn("‹ Prev", `${action}:${String(at - 1)}`)] : []),
  ...(at < pages - 1 ? [btn("Next ›", `${action}:${String(at + 1)}`)] : []),
  btn("‹ Back", "panel"),
];

/** A refusal's sentence (a control refusal, a HandoffError) is the whole
 *  answer; any other failure names what was attempted. */
const failed = (what: string, err: unknown): string =>
  err instanceof HandoffError || (err instanceof Error && (err.message === NO_SESSION || err.message === HAS_SESSION))
    ? err.message
    : `${what}: ${String(err)}`;

/** `undefined` when there is nothing to carry, so a with-session panel's buttons stay bare. */
export const serializeDraft = (draft: PanelDraft): string | undefined =>
  Object.keys(draft).length ? JSON.stringify(draft) : undefined;

/** The question, or the fact that it was too long — measured as the button
 *  carries it, escapes included, not as the bytes the user typed. */
export const holdQuestion = (q: string | undefined): PanelDraft => {
  if (!q) return {};
  return JSON.stringify({ q }).length > DRAFT_CHARS ? { dropped: true } : { q };
};

/** A platform echoed this; only the fields the draft knows, each type-checked. */
export const readDraft = (raw: unknown): PanelDraft => {
  const draft: PanelDraft = {};
  if (!raw || typeof raw !== "object") return draft;
  const v = raw as Record<string, unknown>;
  if (typeof v.cwd === "string") draft.cwd = v.cwd;
  const model = v.model as Record<string, unknown> | undefined;
  if (model && typeof model.provider === "string" && typeof model.id === "string") {
    draft.model = { provider: model.provider, id: model.id };
  }
  if (isThinkingLevel(v.thinking)) draft.thinking = v.thinking;
  if (typeof v.q === "string" && v.q) draft.q = v.q;
  if (v.dropped === true) draft.dropped = true;
  return draft;
};

export abstract class ChatPanel<S extends PanelState, C> {
  private readonly panels = new Map<string, S>();

  constructor(protected readonly deps: PanelDeps) {}

  /** What wraps a fixed-width span in this platform's markup. */
  protected abstract readonly fence: [string, string];
  protected abstract esc(text: string): string;
  protected abstract draw(state: S, view: PanelView, note?: string): Promise<void>;
  /** One typed answer in the platform's dialog: a Slack modal, a Lark form
   *  card; the answer is the draft's directory. */
  protected abstract promptCwd(key: ConversationKey, state: S, ctx: C): Promise<void>;
  protected abstract erase(state: S): Promise<void>;

  protected code(text: string): string {
    return `${this.fence[0]}${this.esc(text)}${this.fence[1]}`;
  }

  protected remember(key: ConversationKey, state: S): void {
    this.panels.set(key.conversationId, state);
  }

  protected state(key: ConversationKey): S | undefined {
    return this.panels.get(key.conversationId);
  }

  // --- rendering ---------------------------------------------------------------

  protected async view(key: ConversationKey, state: S): Promise<PanelView> {
    const status = await this.deps.control.status(key);
    if (!status) return this.draftView(key, state.draft);
    // The conversation is right above the card: no excerpt, and no way to a
    // second session — that is a new thread.
    return {
      groups: [{ title: "Session", lines: this.sessionLines(status) }],
      rows: [[
        btn("Model & reasoning", "pins:0"),
        ...(status.state === "streaming" ? [btn("⏹ Stop", "stop")] : []),
      ]],
    };
  }

  private draftView(key: ConversationKey, draft: PanelDraft): PanelView {
    const { cwd, model, thinking } = this.effective(key, draft);
    const question = draft.q ? [`▸ ${this.esc(cut(draft.q.replace(/\s+/g, " "), QUESTION_CHARS))}`]
      : draft.dropped ? [QUESTION_TOO_LONG] : [];
    return {
      groups: [{
        title: "Session",
        suffix: draft.cwd || draft.model || draft.thinking ? undefined : " · chat defaults",
        lines: [
          `Starts in ${cwd ? this.code(cwd) : "Pier's directory"} · ${
            model ? this.esc(model.id) : "Pi default"
          } · ${thinking ? `reasoning ${thinking}` : "default reasoning"}`,
          ...question,
        ],
      }],
      rows: [
        [btn("Model & reasoning", "pins:0"), btn("Directory…", "cwd"), btn("Continue web session…", "sessions:0")],
        [btn("Start", "start"), btn("Close", "close")],
      ],
    };
  }

  /** What Start would create with: the draft over the chat defaults. */
  private effective(key: ConversationKey, draft: PanelDraft): Pick<PanelDraft, "cwd" | "model" | "thinking"> {
    const launch = this.deps.control.launchFor(key);
    return {
      cwd: draft.cwd ?? launch.cwd,
      model: draft.model ?? launch.model,
      thinking: draft.thinking ?? launch.thinking,
    };
  }

  private sessionLines(status: ConversationStatus): string[] {
    const usage = status.tokens !== null && status.contextWindow
      ? `${compact(status.tokens)}/${compact(status.contextWindow)} tok`
      : "not measured yet";
    const fresh = status.empty && status.state === "idle";
    return [
      `${this.code(status.sessionId.slice(0, 8))} · ${fresh ? "created, no message yet" : status.state}`,
      `Directory: ${this.code(status.cwd || "?")}`,
      `Model: ${
        status.model ? this.esc(status.model.id) : "Pi default"
      } · ${thinkingLabel(status.thinking)}`,
      `Context: ${status.empty ? "empty — the first message you send runs here." : usage}`,
    ];
  }

  /** A listing that failed is one line on the card, logged — never an empty
   *  list that reads as "nothing here". */
  private async listed<T>(read: Promise<T[]>, what: string): Promise<{ items: T[]; unavailable?: string }> {
    try {
      return { items: await read };
    } catch (err) {
      const unavailable = `${what}: ${String(err)}`;
      this.deps.log(unavailable);
      return { items: [], unavailable };
    }
  }

  /** An excerpt, not a summary: the last exchanges are what makes a session
   *  one has been away from recognisable on a phone. */
  private async recentGroups(key: ConversationKey): Promise<PanelGroup[]> {
    const { items: exchanges, unavailable } = await this.listed(
      this.deps.control.recent(key, RECENT_EXCHANGES),
      "Could not read the transcript",
    );
    if (unavailable) return [{ title: "Recent", lines: [unavailable] }];
    const lines = exchanges.flatMap(({ user, assistant }) => {
      const reply = assistant === undefined ? "" : excerpt(assistant, "assistant");
      return [
        `▸ ${this.esc(excerpt(user, "user"))}`,
        ...(reply ? [`◂ ${this.esc(reply)}`] : []),
      ];
    });
    return lines.length ? [{ title: "Recent", lines }] : [];
  }

  protected async refresh(key: ConversationKey, note?: string): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    await this.draw(state, await this.view(key, state), note);
  }

  /** The card's last draw, once an operation completed: the session as it now
   *  is, no button. The panel is released with it, so nothing can tap it again
   *  and the card stays as a record; another @bot opens a fresh one. `recent`
   *  excerpts the transcript — what tells a phone reader which conversation
   *  was continued. */
  private async settle(key: ConversationKey, state: S, note: string, recent: boolean): Promise<void> {
    const status = await this.deps.control.status(key);
    if (!status) return this.refresh(key, note);
    await this.draw(state, {
      groups: [{ title: "Session", lines: this.sessionLines(status) }, ...recent ? await this.recentGroups(key) : []],
      rows: [],
    }, note);
    this.panels.delete(key.conversationId);
  }

  // --- actions -----------------------------------------------------------------

  /** Returns false when the payload is not ours. `recover` rebuilds the state
   *  of a panel whose process died — from the tapped button's value, so the
   *  tap is honoured on the card the user is looking at. `run` hands Start's
   *  pending question to the router as the tapper's message. */
  protected async dispatch(
    key: ConversationKey,
    payload: string,
    ctx: C,
    recover: () => S,
    run: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (!payload.startsWith(PANEL_PREFIX)) return false;
    const [action = "", arg = ""] = payload.slice(PANEL_PREFIX.length).split(":");
    let state = this.state(key);
    if (!state) {
      state = recover();
      this.remember(key, state);
    }
    if (DRAFT_ONLY.has(action) && this.deps.control.knows(key)) {
      await this.refresh(key, HAS_SESSION);
      return true;
    }

    switch (action) {
      case "close":
        this.panels.delete(key.conversationId);
        await this.erase(state);
        return true;
      case "panel":
        await this.refresh(key);
        return true;
      case "pins":
        await this.showPins(key, Number(arg) || 0);
        return true;
      case "pin":
        await this.pickPin(key, Number(arg));
        return true;
      case "sessions":
        await this.showSessions(key, Number(arg) || 0);
        return true;
      case "session":
        await this.pickSession(key, Number(arg));
        return true;
      case "cwd":
        if (arg) await this.pickDir(key, Number(arg));
        else await this.showDirs(key);
        return true;
      case "cwdtype":
        await this.promptCwd(key, state, ctx);
        return true;
      case "start":
        await this.start(key, state, run);
        return true;
      case "stop":
        await this.deps.control.abort(key);
        await this.settle(key, state, "Stop requested.", false);
        return true;
      default:
        this.deps.log(`unknown panel action: ${action}`);
        return true;
    }
  }

  /** The operator's pins, model and reasoning in one pick: the catalog is the
   *  Console's business, and a chat is the wrong place to browse it. */
  private async showPins(key: ConversationKey, page: number): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    const pins = this.deps.control.pins();
    const status = await this.deps.control.status(key);
    const current = status ?? this.effective(key, state.draft);
    const { at, pages, slice, from } = paged(pins, page);
    await this.draw(state, {
      groups: [{
        title: "Model & reasoning",
        suffix: ` · page ${at + 1}/${pages}`,
        lines: slice.length
          ? slice.map((pin, i) => {
            const ticked = current.model?.provider === pin.provider && current.model.id === pin.id
              && current.thinking === pin.thinking;
            return `${String(from + i + 1)}. ${ticked ? "✓ " : ""}${this.esc(pin.id)} · ${
              thinkingLabel(pin.thinking)
            }${pin.note ? ` — ${this.esc(pin.note)}` : ""}`;
          })
          : ["No pinned models — Settings → Models → Model menu."],
      }],
      // The note stays on the line: a platform truncates a button label.
      picks: slice.map((pin, i) => btn(`${String(from + i + 1)} ${pin.id}`, `pin:${String(from + i)}`)),
      rows: [pager("pins", at, pages)],
    });
  }

  private async showSessions(key: ConversationKey, page: number): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    const { items, unavailable } = await this.listed(this.deps.handoff.unbound(SESSIONS_LISTED), "Could not list sessions");
    state.sessions = items;
    const { at, pages, slice, from } = paged(state.sessions, page);
    const now = Date.now();
    await this.draw(state, {
      groups: [{
        title: "Continue web session",
        suffix: ` · page ${at + 1}/${pages}`,
        lines: slice.length
          ? slice.map((s, i) =>
            `${String(from + i + 1)}. ${this.esc(shortTitle(s))} · ${
              this.code(s.cwd.split("/").filter(Boolean).at(-1) ?? s.cwd)
            } · ${age(s.modified ?? s.createdAt, now)}`)
          : [unavailable ?? "No unbound sessions."],
      }],
      picks: slice.map((s, i) => btn(`${String(from + i + 1)} ${shortTitle(s)}`, `session:${String(from + i)}`)),
      rows: [pager("sessions", at, pages)],
    });
  }

  private async pickSession(key: ConversationKey, index: number): Promise<void> {
    const state = this.state(key);
    const session = state?.sessions[index];
    if (!state || !session) return this.refresh(key, "That session is no longer listed.");
    try {
      await this.deps.handoff.continueHere(key, session.id);
      // The bound session has its own settings; the draft is spent.
      state.draft = {};
      await this.settle(key, state, `Continuing session ${session.id.slice(0, 8)} — reply in this thread.`, true);
    } catch (err) {
      await this.refresh(key, failed("Could not continue that session", err));
    }
  }

  private async pickPin(key: ConversationKey, index: number): Promise<void> {
    const state = this.state(key);
    const pin = this.deps.control.pins()[index];
    if (!state || !pin) return this.refresh(key, "That model is no longer listed.");
    const model = { provider: pin.provider, id: pin.id };
    if (!this.deps.control.knows(key)) {
      state.draft = { ...state.draft, model, thinking: pin.thinking };
      return this.refresh(key);
    }
    try {
      await this.deps.control.setModel(key, model);
      await this.deps.control.setThinking(key, pin.thinking);
      await this.settle(key, state, `Model set to ${pin.id} · ${thinkingLabel(pin.thinking)}.`, false);
    } catch (err) {
      await this.refresh(key, failed("Could not set that model", err));
    }
  }

  private async showDirs(key: ConversationKey): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    const { items, unavailable } = await this.listed(this.deps.control.recentDirs(key), "Could not list recent directories");
    state.dirs = items;
    await this.draw(state, {
      groups: [{
        title: "Directory",
        lines: state.dirs.length
          ? state.dirs.map((dir, i) => `${String(i + 1)}. ${this.code(dir)}`)
          : [unavailable ?? "No sessions yet — type a path."],
      }],
      picks: state.dirs.map((dir, i) => btn(`${String(i + 1)} ${shortDir(dir)}`, `cwd:${String(i)}`)),
      rows: [[btn("Type a path…", "cwdtype"), btn("‹ Back", "panel")]],
    });
  }

  private async pickDir(key: ConversationKey, index: number): Promise<void> {
    const dir = this.state(key)?.dirs[index];
    if (!dir) return this.refresh(key, "That directory is no longer listed.");
    await this.chooseDir(key, dir);
  }

  /** Pi fixes cwd at session creation, so a directory is only ever the draft's:
   *  a thread that already has a session keeps it, and a new one is a new thread. */
  protected async chooseDir(key: ConversationKey, path: string): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    if (this.deps.control.knows(key)) return this.refresh(key, HAS_SESSION);
    if (!path.startsWith("/")) return this.refresh(key, "That is not an absolute path — nothing changed.");
    state.draft = { ...state.draft, cwd: path };
    await this.refresh(key);
  }

  /** Create with the draft, bind the thread, run the question as the tapper's
   *  first message. A session that appeared meanwhile (a message raced the
   *  tap) is not replaced: the draft would orphan it. */
  private async start(key: ConversationKey, state: S, run: (text: string) => Promise<void>): Promise<void> {
    if (this.deps.control.knows(key)) return this.refresh(key, HAS_SESSION);
    const { q, dropped: _dropped, ...launch } = state.draft;
    let id: string;
    try {
      id = await this.deps.control.newSession(key, launch);
    } catch (err) {
      return this.refresh(key, failed("Could not start a session", err));
    }
    state.draft = {};
    if (q) {
      await run(q);
      return this.settle(key, state, `Started ${id.slice(0, 8)} — running your question.`, false);
    }
    const cwd = (await this.deps.control.status(key))?.cwd ?? launch.cwd ?? "?";
    await this.settle(key, state, `Started ${id.slice(0, 8)} in ${cwd}.`, false);
  }
}
