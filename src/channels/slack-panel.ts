// The in-chat settings panel: what `@bot` and `/settings` open on Slack.
//
// Same contract as the Telegram panel — one message edited in place, every
// payload namespaced `cfg:` so a panel click can never be mistaken for one of
// the agent's next-step buttons, and an index rather than a name in the payload.
//
// One thing is genuinely nicer here: Slack has modals, so "new session in a
// directory" asks for the path in a `views.open` dialog instead of Telegram's
// force-reply. The conversation id rides along in `private_metadata`, which
// means the typed answer needs no adapter-side state to be understood — the
// trap Telegram's cwd prompt pays for with a Map.

import { compact, thinkingLabel } from "../core/reply.js";
import type { ConversationKey, ModelRef, ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl, ConversationStatus } from "./control.js";
import type { SlackBlock, SlackButton, SlackClient, SlackInteraction } from "./slack-api.js";
import { context, escapeMrkdwn as esc, section } from "./slack-render.js";
import type { ChatConfig } from "./types.js";

const PREFIX = "cfg:";
const MODELS_PER_PAGE = 8;
/** The modal's ids. `private_metadata` carries which conversation it is for. */
const CWD_VIEW = "cfg_cwd";
const CWD_BLOCK = "cwd_block";
const CWD_INPUT = "cwd_input";

const onOff = (v: boolean): string => (v ? "on" : "off");

const button = (text: string, action: string): SlackButton => ({
  type: "button",
  action_id: `${PREFIX}${action}`,
  text: { type: "plain_text", text, emoji: true },
});

const row = (...elements: SlackButton[]): SlackBlock => ({ type: "actions", elements });

export interface SlackPanelDeps {
  api: Pick<SlackClient, "postMessage" | "updateMessage" | "deleteMessage" | "openView">;
  control: ChannelControl;
  store: ChannelStore;
  log(message: string): void;
}

/**
 * Where a conversation's panel lives, plus the model list its indices mean.
 * The channel and thread are kept here rather than decoded back out of the
 * conversation id: the adapter already knew them when it opened the panel.
 */
interface PanelState {
  channel: string;
  threadTs: string;
  ts: string;
  models: ModelRef[];
}

export class SlackPanel {
  private readonly panels = new Map<string, PanelState>();

  constructor(private readonly deps: SlackPanelDeps) {}

  // --- rendering -------------------------------------------------------------

  private async blocks(key: ConversationKey, channel: string): Promise<SlackBlock[]> {
    const chat = this.deps.store.chat("slack", channel);
    const status = await this.deps.control.status(key);
    return [
      section(
        [
          "*Session*",
          status ? this.sessionLines(status) : "None yet — send a message to start one.",
        ].flat().join("\n"),
      ),
      section(["*Channel*", this.chatLines(channel, chat)].flat().join("\n")),
      ...this.buttons(status),
    ];
  }

  private sessionLines(status: ConversationStatus): string[] {
    const usage = status.tokens !== null && status.contextWindow
      ? `${compact(status.tokens)}/${compact(status.contextWindow)} tok`
      : "not measured yet";
    return [
      `\`${status.sessionId.slice(0, 8)}\` · ${status.state}`,
      `Directory: \`${esc(status.cwd || "?")}\``,
      `Model: ${status.model ? esc(status.model.id) : "Pi default"} · ${thinkingLabel(status.thinking)}`,
      `Context: ${usage}`,
    ];
  }

  private chatLines(channel: string, chat: ChatConfig | undefined): string[] {
    if (!chat) return [`\`${esc(channel)}\``];
    const policy = this.deps.store.policy("slack", channel);
    // A DM is bind-only by construction, so the group knobs would be a lie.
    // Threads are not a toggle on Slack: every reply lands in one, always.
    const gates = chat.kind === "dm"
      ? "bound users only"
      : `mention ${onOff(policy.requireMention)} · bind ${onOff(policy.requireBind)}`;
    return [`${esc(chat.name || channel)} · ${chat.kind} · \`${esc(channel)}\``, gates];
  }

  private buttons(status: ConversationStatus | null): SlackBlock[] {
    return [
      row(button("Model", "models:0"), button("Reasoning", "think")),
      row(
        button("New session", "new"),
        button("New session in…", "cwd"),
        ...(status?.state === "streaming" ? [button("⏹ Stop", "stop")] : []),
        button("Close", "close"),
      ),
    ];
  }

  /** Open a fresh panel, replacing whichever one this conversation had. */
  async open(key: ConversationKey, channel: string, threadTs: string): Promise<void> {
    const blocks = await this.blocks(key, channel);
    const sent = await this.deps.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Settings",
      blocks,
    });
    this.panels.set(key.conversationId, { channel, threadTs, ts: sent.ts, models: [] });
  }

  /** Redraw the panel this conversation owns. */
  private async refresh(key: ConversationKey, note?: string): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    if (!panel) return;
    const blocks = await this.blocks(key, panel.channel);
    await this.edit(panel, note ? [...blocks, context(esc(note))] : blocks);
  }

  private async edit(panel: PanelState, blocks: SlackBlock[]): Promise<void> {
    await this.deps.api.updateMessage({
      channel: panel.channel,
      ts: panel.ts,
      text: "Settings",
      blocks,
    }).catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  // --- actions ---------------------------------------------------------------

  /**
   * Handle a `cfg:` click. Returns false when the action is not ours, so the
   * caller can treat it as one of the agent's next-step labels instead.
   */
  async onAction(
    interaction: SlackInteraction,
    key: ConversationKey,
    actionId: string,
  ): Promise<boolean> {
    if (!actionId.startsWith(PREFIX)) return false;
    const [action = "", arg = ""] = actionId.slice(PREFIX.length).split(":");
    const panel = this.panels.get(key.conversationId);
    // A panel from a previous process has no state here; reopening on the first
    // click is the only honest recovery, and it costs one click.
    if (!panel && action !== "close") {
      const channel = interaction.channel?.id;
      const message = interaction.message;
      if (channel && message) {
        await this.open(key, channel, message.thread_ts ?? message.ts);
      }
      return true;
    }

    switch (action) {
      case "close":
        this.panels.delete(key.conversationId);
        if (panel) {
          await this.deps.api.deleteMessage(panel.channel, panel.ts)
            .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
        }
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
        await this.promptCwd(key, interaction);
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
    const panel = this.panels.get(key.conversationId);
    if (!panel) return;
    panel.models = await this.deps.control.models().catch(() => []);
    const status = await this.deps.control.status(key);
    const pages = Math.max(1, Math.ceil(panel.models.length / MODELS_PER_PAGE));
    const at = Math.min(Math.max(page, 0), pages - 1);
    const slice = panel.models.slice(at * MODELS_PER_PAGE, (at + 1) * MODELS_PER_PAGE);
    // Paging by index, not by name — the same reason as Telegram, minus the
    // byte cap: an index cannot be invalidated by a label the agent rewrote.
    const picks = slice.map((model, i) => {
      const index = at * MODELS_PER_PAGE + i;
      const current = status?.model?.provider === model.provider && status.model.id === model.id;
      return button(`${current ? "✓ " : ""}${model.id}`, `model:${index}`);
    });
    const nav = [
      ...(at > 0 ? [button("‹ Prev", `models:${at - 1}`)] : []),
      ...(at < pages - 1 ? [button("Next ›", `models:${at + 1}`)] : []),
      button("‹ Back", "panel"),
    ];
    await this.edit(panel, [
      section(
        `*Model* · page ${at + 1}/${pages}${
          panel.models.length ? "" : "\n\nNo models with configured auth."
        }`,
      ),
      ...(picks.length ? [row(...picks)] : []),
      row(...nav),
    ]);
  }

  private async pickModel(key: ConversationKey, index: number): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    const model = panel?.models[index];
    if (!model) return this.refresh(key, "That model is no longer listed.");
    try {
      await this.deps.control.setModel(key, model);
      await this.refresh(key, `Model set to ${model.id}.`);
    } catch (err) {
      await this.refresh(key, `Could not set that model: ${String(err)}`);
    }
  }

  private async showThinking(key: ConversationKey): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    if (!panel) return;
    const status = await this.deps.control.status(key);
    const levels = status?.thinkingLevels ?? [];
    const picks = levels.map((level) =>
      button(`${status?.thinking === level ? "✓ " : ""}${thinkingLabel(level)}`, `think:${level}`)
    );
    await this.edit(panel, [
      section(`*Reasoning*${levels.length ? "" : "\n\nThis model has no levels."}`),
      ...(picks.length ? [row(...picks)] : []),
      row(button("‹ Back", "panel")),
    ]);
  }

  private async pickThinking(key: ConversationKey, level: ThinkingLevel): Promise<void> {
    await this.deps.control.setThinking(key, level);
    await this.refresh(key, `Reasoning set to ${thinkingLabel(level)}.`);
  }

  // --- working directory (one typed answer, in a modal) ----------------------

  /**
   * Pi fixes cwd at session creation, so "change the working directory" *is*
   * "start a new session there" — the modal says exactly that rather than
   * implying the running session moves.
   */
  private async promptCwd(key: ConversationKey, interaction: SlackInteraction): Promise<void> {
    const trigger = interaction.trigger_id;
    if (!trigger) {
      await this.refresh(key, "Could not open the dialog — try again.");
      return;
    }
    await this.deps.api.openView(trigger, {
      type: "modal",
      callback_id: CWD_VIEW,
      // The conversation travels with the modal, so the submission needs no
      // adapter-side state to be understood — and survives a reload.
      private_metadata: key.conversationId,
      title: { type: "plain_text", text: "New session" },
      submit: { type: "plain_text", text: "Start" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: CWD_BLOCK,
          label: { type: "plain_text", text: "Working directory" },
          hint: {
            type: "plain_text",
            text: "An absolute path. A new session starts there; the current one stays in its own directory.",
          },
          element: {
            type: "plain_text_input",
            action_id: CWD_INPUT,
            placeholder: { type: "plain_text", text: "/path/to/project" },
          },
        },
      ],
    }).catch((err) => this.deps.log(`cwd modal failed: ${String(err)}`));
  }

  /**
   * Consume a modal submission. Returns the conversation it belonged to, or
   * undefined when the view is not ours.
   */
  async onViewSubmission(interaction: SlackInteraction): Promise<boolean> {
    const view = interaction.view;
    if (view?.callback_id !== CWD_VIEW) return false;
    const conversationId = view.private_metadata ?? "";
    const key: ConversationKey = { channelId: "slack", conversationId };
    const path = (view.state?.values?.[CWD_BLOCK]?.[CWD_INPUT]?.value ?? "").trim();
    // Rejecting a relative path changes nothing, and says so: a silent no-op
    // here reads as "the button is broken".
    if (!path.startsWith("/")) {
      await this.refresh(key, "That is not an absolute path — nothing changed.");
      return true;
    }
    try {
      const id = await this.deps.control.newSession(key, path);
      await this.refresh(key, `Started session ${id.slice(0, 8)} in ${path}.`);
    } catch (err) {
      await this.refresh(key, `Could not start a session there: ${String(err)}`);
    }
    return true;
  }
}
