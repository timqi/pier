// The in-chat settings panel, minus the platform: one message edited in place,
// every payload namespaced `cfg:` so a tap never reaches the agent. Choices
// travel as an index: platform callback payloads are small and opaque.

import { sessionLabel } from "../core/identity.js";
import { compact, thinkingLabel } from "../core/reply.js";
import type { ConversationKey, ModelRef, SessionSummary, ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import { type ChannelControl, type ConversationStatus, NO_SESSION } from "./control.js";
import { type Handoff, HandoffError } from "./handoff.js";
import type { ChannelPlatform, ChatConfig, ChatPolicy } from "./types.js";

export const PANEL_PREFIX = "cfg:";
const PER_PAGE = 8;
/** The picker's reach: five pages of the newest unbound sessions. */
const SESSIONS_LISTED = 40;
const TITLE_CHARS = 40;

/** The pull half of the handoff; the push half never needs a panel. */
export type PanelHandoff = Pick<Handoff, "unbound" | "continueHere">;

export const CWD_TAIL = "The session is created there at once; the first message you send in this thread runs in it.";
export const CWD_PLACEHOLDER = "/path/to/project";

const onOff = (v: boolean): string => (v ? "on" : "off");

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

export interface PanelDeps {
  control: ChannelControl;
  handoff: PanelHandoff;
  store: ChannelStore;
  log(message: string): void;
}

export interface PanelState {
  chatId: string;
  /** The lists the payloads' indices point into. */
  models: ModelRef[];
  dirs: string[];
  sessions: SessionSummary[];
}

const btn = (label: string, action: string): PanelButton => ({ label, action });

/** A button label is the last two segments; the numbered line above has the whole path. */
const shortDir = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

const shortTitle = (s: SessionSummary): string => {
  const title = sessionLabel(s);
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
};

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

const created = (id: string, where: string): string =>
  `Created session ${id.slice(0, 8)} ${where} — nothing has run yet; the first message you send in this thread starts it.`;

/** NO_SESSION is the whole answer; any other failure names what was attempted. */
const failed = (what: string, err: unknown): string =>
  err instanceof Error && err.message === NO_SESSION ? NO_SESSION : `${what}: ${String(err)}`;

export abstract class ChatPanel<S extends PanelState, C> {
  private readonly panels = new Map<string, S>();

  constructor(protected readonly deps: PanelDeps) {}

  protected abstract readonly platform: ChannelPlatform;
  /** What wraps a fixed-width span in this platform's markup. */
  protected abstract readonly fence: [string, string];
  protected abstract esc(text: string): string;
  protected abstract draw(state: S, view: PanelView, note?: string): Promise<void>;
  /** One typed answer in the platform's dialog: a Slack modal, a Lark form card. */
  protected abstract promptCwd(key: ConversationKey, state: S, ctx: C): Promise<void>;
  protected abstract erase(state: S): Promise<void>;
  /** Gates this platform has and the other does not. */
  protected gateExtras(_chat: ChatConfig, _policy: ChatPolicy): string {
    return "";
  }

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

  protected async view(key: ConversationKey, chatId: string): Promise<PanelView> {
    const status = await this.deps.control.status(key);
    return {
      groups: [
        {
          title: "Session",
          lines: status
            ? this.sessionLines(status)
            : [
              "None in this thread yet — your first message starts one with the chat defaults below.",
              "To choose the directory first, tap New session in….",
            ],
        },
        {
          title: this.platform === "slack" ? "Channel" : "Chat",
          lines: [...this.chatLines(chatId), this.defaultsLine(key)],
        },
      ],
      rows: [
        [btn("Model", "models:0"), btn("Reasoning", "think")],
        [
          btn("New session", "new"),
          btn("New session in…", "cwd"),
          ...(status ? [] : [btn("Continue web session…", "sessions:0")]),
        ],
        [
          ...(status?.state === "streaming" ? [btn("⏹ Stop", "stop")] : []),
          btn("Close", "close"),
        ],
      ],
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

  /** Display only: the chat's launch config is the Console's to change. */
  private defaultsLine(key: ConversationKey): string {
    const launch = this.deps.control.launchFor(key);
    return `New sessions start in ${launch.cwd ? this.code(launch.cwd) : "Pier's directory"} · ${
      launch.model ? this.esc(launch.model.id) : "Pi default"
    } · ${launch.thinking ? `reasoning ${launch.thinking}` : "default reasoning"}`;
  }

  private chatLines(chatId: string): string[] {
    const chat = this.deps.store.chat(this.platform, chatId);
    if (!chat) return [this.code(chatId)];
    const policy = this.deps.store.policy(this.platform, chatId);
    // A DM is bind-only by construction, so the group knobs would be a lie.
    const gates = chat.kind === "dm"
      ? "bound users only"
      : `mention ${onOff(policy.requireMention)} · bind ${onOff(policy.requireBind)}${
        this.gateExtras(chat, policy)
      }`;
    return [`${this.esc(chat.name || chatId)} · ${chat.kind} · ${this.code(chatId)}`, gates];
  }

  protected async refresh(key: ConversationKey, note?: string): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    await this.draw(state, await this.view(key, state.chatId), note);
  }

  // --- actions -----------------------------------------------------------------

  /** Returns false when the payload is not ours. `reopen` recovers a panel
   *  whose state died with a previous process; it costs one tap. */
  protected async dispatch(
    key: ConversationKey,
    payload: string,
    ctx: C,
    reopen: () => Promise<void>,
  ): Promise<boolean> {
    if (!payload.startsWith(PANEL_PREFIX)) return false;
    const [action = "", arg = ""] = payload.slice(PANEL_PREFIX.length).split(":");
    const state = this.state(key);
    if (!state && action !== "close") {
      await reopen();
      return true;
    }

    switch (action) {
      case "close":
        this.panels.delete(key.conversationId);
        if (state) await this.erase(state);
        return true;
      case "panel":
        await this.refresh(key);
        return true;
      case "models":
        await this.showModels(key, Number(arg) || 0);
        return true;
      case "model":
        await this.pickModel(key, Number(arg));
        return true;
      case "sessions":
        await this.showSessions(key, Number(arg) || 0);
        return true;
      case "session":
        await this.pickSession(key, Number(arg));
        return true;
      case "think":
        if (arg) await this.pickThinking(key, arg as ThinkingLevel);
        else await this.showThinking(key);
        return true;
      case "new": {
        const id = await this.deps.control.newSession(key);
        await this.refresh(key, created(id, "in its directory"));
        return true;
      }
      case "cwd":
        if (arg) await this.pickDir(key, Number(arg));
        else await this.showDirs(key);
        return true;
      case "cwdtype":
        await this.promptCwd(key, state!, ctx);
        return true;
      case "stop":
        await this.deps.control.abort(key);
        await this.refresh(key, "Stop requested.");
        return true;
      default:
        this.deps.log(`unknown panel action: ${action}`);
        return true;
    }
  }

  private async showModels(key: ConversationKey, page: number): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    // An empty list and a catalog that could not be read are two different
    // answers; the second must not draw as the first.
    let unavailable: string | undefined;
    state.models = await this.deps.control.models().catch((err: unknown) => {
      unavailable = `Could not list models: ${String(err)}`;
      this.deps.log(unavailable);
      return [];
    });
    const status = await this.deps.control.status(key);
    const { at, pages, slice, from } = paged(state.models, page);
    await this.draw(state, {
      groups: [{
        title: "Model",
        suffix: ` · page ${at + 1}/${pages}`,
        lines: state.models.length ? [] : [unavailable ?? "No models with configured auth."],
      }],
      picks: slice.map((model, i) => {
        const current = status?.model?.provider === model.provider && status.model.id === model.id;
        return btn(`${current ? "✓ " : ""}${model.id}`, `model:${from + i}`);
      }),
      rows: [pager("models", at, pages)],
    });
  }

  private async showSessions(key: ConversationKey, page: number): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    let unavailable: string | undefined;
    state.sessions = await this.deps.handoff.unbound(SESSIONS_LISTED).catch((err: unknown) => {
      unavailable = `Could not list sessions: ${String(err)}`;
      this.deps.log(unavailable);
      return [];
    });
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
    const session = this.state(key)?.sessions[index];
    if (!session) return this.refresh(key, "That session is no longer listed.");
    try {
      await this.deps.handoff.continueHere(key, session.id);
      await this.refresh(key, `Continuing session ${session.id.slice(0, 8)} — reply in this thread.`);
    } catch (err) {
      // A refusal's sentence is the whole answer ("Already answers in …").
      await this.refresh(key, err instanceof HandoffError ? err.message : `Could not continue that session: ${String(err)}`);
    }
  }

  private async pickModel(key: ConversationKey, index: number): Promise<void> {
    const model = this.state(key)?.models[index];
    if (!model) return this.refresh(key, "That model is no longer listed.");
    try {
      await this.deps.control.setModel(key, model);
      await this.refresh(key, `Model set to ${model.id}.`);
    } catch (err) {
      await this.refresh(key, failed("Could not set that model", err));
    }
  }

  private async showDirs(key: ConversationKey): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    let unavailable: string | undefined;
    state.dirs = await this.deps.control.recentDirs(key).catch((err: unknown) => {
      unavailable = `Could not list recent directories: ${String(err)}`;
      this.deps.log(unavailable);
      return [];
    });
    await this.draw(state, {
      groups: [{
        title: "New session in",
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
    await this.startSessionIn(key, dir);
  }

  private async showThinking(key: ConversationKey): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    const status = await this.deps.control.status(key);
    const levels = status?.thinkingLevels ?? [];
    await this.draw(state, {
      groups: [{
        title: "Reasoning",
        lines: levels.length ? [] : ["This model has no levels."],
      }],
      picks: levels.map((level) =>
        btn(`${status?.thinking === level ? "✓ " : ""}${thinkingLabel(level)}`, `think:${level}`)
      ),
      rows: [[btn("‹ Back", "panel")]],
    });
  }

  private async pickThinking(key: ConversationKey, level: ThinkingLevel): Promise<void> {
    try {
      await this.deps.control.setThinking(key, level);
      await this.refresh(key, `Reasoning set to ${thinkingLabel(level)}.`);
    } catch (err) {
      await this.refresh(key, failed("Could not set reasoning", err));
    }
  }

  /** Pi fixes cwd at session creation, so "change the working directory" *is*
   *  "start a new session there". */
  protected async startSessionIn(
    key: ConversationKey,
    path: string,
  ): Promise<{ id: string } | { error: string }> {
    if (!path.startsWith("/")) {
      const error = "That is not an absolute path — nothing changed.";
      await this.refresh(key, error);
      return { error };
    }
    try {
      const id = await this.deps.control.newSession(key, path);
      await this.refresh(key, created(id, `in ${path}`));
      return { id };
    } catch (err) {
      const error = `Could not start a session there: ${String(err)}`;
      await this.refresh(key, error);
      return { error };
    }
  }
}
