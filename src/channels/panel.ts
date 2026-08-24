// The in-chat settings panel, minus the platform.
//
// One message edited in place — a new message per tap would bury the chat.
// Every payload is namespaced `cfg:` and consumed here, so a panel tap can
// never be mistaken for one of the agent's next-step buttons (whose payload is
// the label itself) and never reaches the agent. Choices travel as an index
// rather than a name: Telegram's callback data caps at 64 bytes, and an index
// cannot be invalidated by a label someone rewrote.
//
// What is left to a platform is markup, how its one message is sent, edited
// and deleted, and how it asks for a single typed answer — Slack has modals,
// Telegram has a forced reply. Everything above that is the same panel, so it
// is written once here.

import { compact, thinkingLabel } from "../core/reply.js";
import type { ConversationKey, ModelRef, ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl, ConversationStatus } from "./control.js";
import type { ChannelPlatform, ChatConfig, ChatPolicy } from "./types.js";

export const PANEL_PREFIX = "cfg:";
const MODELS_PER_PAGE = 8;

/** The cwd prompt's one sentence and placeholder — each platform owns only
 *  its widget's lead-in ("Reply with…", a modal hint, a form label). */
export const CWD_TAIL = "A new session starts there; the current one stays in its own directory.";
export const CWD_PLACEHOLDER = "/path/to/project";

const onOff = (v: boolean): string => (v ? "on" : "off");

export interface PanelButton {
  label: string;
  /** Goes into the payload behind `PANEL_PREFIX`. */
  action: string;
}

/** A titled block of lines: one Slack section, one Telegram paragraph. */
export interface PanelGroup {
  title: string;
  /** Trails the title outside the emphasis, for a counter or a hint. */
  suffix?: string;
  lines: string[];
}

export interface PanelView {
  groups: PanelGroup[];
  /**
   * A list of same-kind choices. Laid out by the platform, because that is
   * where the constraint lives: Slack fits them on one row, Telegram gives a
   * long model id a row of its own.
   */
  picks?: PanelButton[];
  /** Button rows, taken as authored. */
  rows: PanelButton[][];
}

export interface PanelDeps {
  control: ChannelControl;
  store: ChannelStore;
  log(message: string): void;
}

/** What every panel remembers, beside where its own message is. */
export interface PanelState {
  /**
   * The chat the panel is in. Kept rather than decoded back out of the
   * conversation id: the adapter already knew it when it opened the panel.
   */
  chatId: string;
  /** The list the payload's indices point into. */
  models: ModelRef[];
}

const btn = (label: string, action: string): PanelButton => ({ label, action });

export abstract class ChatPanel<S extends PanelState, C> {
  private readonly panels = new Map<string, S>();

  constructor(protected readonly deps: PanelDeps) {}

  protected abstract readonly platform: ChannelPlatform;
  /** What wraps a fixed-width span in this platform's markup. */
  protected abstract readonly fence: [string, string];
  /** Escape text that is not markup. */
  protected abstract esc(text: string): string;
  /** Paint the view onto the panel's one message. */
  protected abstract draw(state: S, view: PanelView, note?: string): Promise<void>;
  /** Ask for a working directory: a modal, or a forced reply. */
  protected abstract promptCwd(key: ConversationKey, state: S, ctx: C): Promise<void>;
  /** Take the panel message down. */
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

  /** The panel proper: this session, this chat, and what can be done to them. */
  protected async view(key: ConversationKey, chatId: string): Promise<PanelView> {
    const status = await this.deps.control.status(key);
    return {
      groups: [
        {
          title: "Session",
          lines: status
            ? this.sessionLines(status)
            : ["None yet — send a message to start one."],
        },
        // Slack calls it a channel, Telegram a chat; the panel says what the
        // person reading it says.
        {
          title: this.platform === "slack" ? "Channel" : "Chat",
          lines: this.chatLines(chatId),
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
    return [
      `${this.code(status.sessionId.slice(0, 8))} · ${status.state}`,
      `Directory: ${this.code(status.cwd || "?")}`,
      `Model: ${
        status.model ? this.esc(status.model.id) : "Pi default"
      } · ${thinkingLabel(status.thinking)}`,
      `Context: ${usage}`,
    ];
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

  /** Redraw the panel this conversation owns. */
  protected async refresh(key: ConversationKey, note?: string): Promise<void> {
    const state = this.state(key);
    if (!state) return;
    await this.draw(state, await this.view(key, state.chatId), note);
  }

  // --- actions -----------------------------------------------------------------

  /**
   * Handle a `cfg:` payload. Returns false when it is not ours, so the caller
   * can treat it as one of the agent's next-step labels instead.
   *
   * `reopen` is how a panel left behind by a previous process recovers: its
   * state died with that process, and redrawing from the platform's own copy
   * of the message is the only honest answer. It costs one tap.
   */
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
    state.models = await this.deps.control.models().catch(() => []);
    const status = await this.deps.control.status(key);
    const pages = Math.max(1, Math.ceil(state.models.length / MODELS_PER_PAGE));
    const at = Math.min(Math.max(page, 0), pages - 1);
    const slice = state.models.slice(at * MODELS_PER_PAGE, (at + 1) * MODELS_PER_PAGE);
    await this.draw(state, {
      groups: [{
        title: "Model",
        suffix: ` · page ${at + 1}/${pages}`,
        lines: state.models.length ? [] : ["No models with configured auth."],
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
      await this.refresh(key, `Could not set that model: ${String(err)}`);
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
    await this.deps.control.setThinking(key, level);
    await this.refresh(key, `Reasoning set to ${thinkingLabel(level)}.`);
  }

  /**
   * The one action that is not reversible in place: Pi fixes cwd at session
   * creation, so "change the working directory" *is* "start a new session
   * there". Shared because both platforms have to say so and handle the same
   * two failures.
   */
  protected async startSessionIn(
    key: ConversationKey,
    path: string,
  ): Promise<{ id: string } | { error: string }> {
    if (!path.startsWith("/")) {
      // A silent no-op here reads as "the button is broken".
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
