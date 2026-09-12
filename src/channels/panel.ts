// The in-chat settings panel, minus the platform: one message edited in place,
// every payload namespaced `cfg:` so a tap never reaches the agent. Choices
// travel as an index: platform callback payloads are small and opaque.

import { compact, thinkingLabel } from "../core/reply.js";
import type { ConversationKey, ModelRef, ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import { type ChannelControl, type ConversationStatus, NO_SESSION } from "./control.js";
import type { ChannelPlatform, ChatConfig, ChatPolicy } from "./types.js";

export const PANEL_PREFIX = "cfg:";
const MODELS_PER_PAGE = 8;

export const CWD_TAIL = "A new session starts there; the current one stays in its own directory.";
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
  store: ChannelStore;
  log(message: string): void;
}

export interface PanelState {
  chatId: string;
  /** The list the payload's indices point into. */
  models: ModelRef[];
}

const btn = (label: string, action: string): PanelButton => ({ label, action });

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
        [btn("New session", "new"), btn("New session in…", "cwd")],
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
      case "think":
        if (arg) await this.pickThinking(key, arg as ThinkingLevel);
        else await this.showThinking(key);
        return true;
      case "new": {
        const id = await this.deps.control.newSession(key);
        await this.refresh(key, `Started session ${id.slice(0, 8)}.`);
        return true;
      }
      case "cwd":
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
    const pages = Math.max(1, Math.ceil(state.models.length / MODELS_PER_PAGE));
    const at = Math.min(Math.max(page, 0), pages - 1);
    const slice = state.models.slice(at * MODELS_PER_PAGE, (at + 1) * MODELS_PER_PAGE);
    await this.draw(state, {
      groups: [{
        title: "Model",
        suffix: ` · page ${at + 1}/${pages}`,
        lines: state.models.length ? [] : [unavailable ?? "No models with configured auth."],
      }],
      picks: slice.map((model, i) => {
        const current = status?.model?.provider === model.provider && status.model.id === model.id;
        return btn(`${current ? "✓ " : ""}${model.id}`, `model:${at * MODELS_PER_PAGE + i}`);
      }),
      rows: [[
        ...(at > 0 ? [btn("‹ Prev", `models:${at - 1}`)] : []),
        ...(at < pages - 1 ? [btn("Next ›", `models:${at + 1}`)] : []),
        btn("‹ Back", "panel"),
      ]],
    });
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
      await this.refresh(key, `Started session ${id.slice(0, 8)} in ${path}.`);
      return { id };
    } catch (err) {
      const error = `Could not start a session there: ${String(err)}`;
      await this.refresh(key, error);
      return { error };
    }
  }
}
