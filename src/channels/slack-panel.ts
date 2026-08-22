// Slack's half of the settings panel: mrkdwn markup, Block Kit, and a modal
// for the one typed answer. The panel itself lives in `panel.ts`.
//
// The modal is what makes this half smaller than Telegram's: `private_metadata`
// carries the conversation with the dialog, so a submitted path needs no
// adapter-side state to be understood, and survives a reload.

import type { ConversationKey } from "../core/types.js";
import {
  ChatPanel,
  PANEL_PREFIX,
  type PanelButton,
  type PanelDeps,
  type PanelState,
  type PanelView,
} from "./panel.js";
import type { SlackBlock, SlackButton, SlackClient, SlackInteraction } from "./slack-api.js";
import { context, escapeMrkdwn as esc, section } from "./slack-render.js";

/** The modal's ids. `private_metadata` carries which conversation it is for. */
const CWD_VIEW = "cfg_cwd";
const CWD_BLOCK = "cwd_block";
const CWD_INPUT = "cwd_input";

export interface SlackPanelDeps extends PanelDeps {
  api: Pick<SlackClient, "postMessage" | "updateMessage" | "deleteMessage" | "openView">;
}

/** Where this conversation's panel lives. */
interface SlackPanelState extends PanelState {
  threadTs: string;
  ts: string;
}

const button = (b: PanelButton): SlackButton => ({
  type: "button",
  action_id: `${PANEL_PREFIX}${b.action}`,
  text: { type: "plain_text", text: b.label, emoji: true },
});

const row = (buttons: PanelButton[]): SlackBlock => ({
  type: "actions",
  elements: buttons.map(button),
});

export class SlackPanel extends ChatPanel<SlackPanelState, SlackInteraction> {
  protected readonly platform = "slack" as const;
  protected readonly fence: [string, string] = ["`", "`"];

  constructor(protected override readonly deps: SlackPanelDeps) {
    super(deps);
  }

  protected esc(text: string): string {
    return esc(text);
  }

  // --- rendering -------------------------------------------------------------

  private blocks(view: PanelView, note?: string): SlackBlock[] {
    return [
      ...view.groups.map((g) => section([`*${g.title}*${g.suffix ?? ""}`, ...g.lines].join("\n"))),
      // Slack fits a page of choices on one row; Telegram would not.
      ...(view.picks?.length ? [row(view.picks)] : []),
      ...view.rows.filter((r) => r.length).map(row),
      ...(note ? [context(esc(note))] : []),
    ];
  }

  /** Open a fresh panel, replacing whichever one this conversation had. */
  async open(key: ConversationKey, channel: string, threadTs: string): Promise<void> {
    const sent = await this.deps.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Settings",
      blocks: this.blocks(await this.view(key, channel)),
    });
    this.remember(key, { chatId: channel, threadTs, ts: sent.ts, models: [] });
  }

  protected async draw(state: SlackPanelState, view: PanelView, note?: string): Promise<void> {
    await this.deps.api.updateMessage({
      channel: state.chatId,
      ts: state.ts,
      text: "Settings",
      blocks: this.blocks(view, note),
    }).catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  protected async erase(state: SlackPanelState): Promise<void> {
    await this.deps.api.deleteMessage(state.chatId, state.ts)
      .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
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
    return this.dispatch(key, actionId, interaction, async () => {
      const channel = interaction.channel?.id;
      const message = interaction.message;
      if (channel && message) await this.open(key, channel, message.thread_ts ?? message.ts);
    });
  }

  // --- working directory (one typed answer, in a modal) ----------------------

  protected async promptCwd(
    key: ConversationKey,
    _state: SlackPanelState,
    interaction: SlackInteraction,
  ): Promise<void> {
    const trigger = interaction.trigger_id;
    if (!trigger) {
      await this.refresh(key, "Could not open the dialog — try again.");
      return;
    }
    await this.deps.api.openView(trigger, {
      type: "modal",
      callback_id: CWD_VIEW,
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
            text:
              "An absolute path. A new session starts there; the current one stays in its own directory.",
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

  /** Consume a modal submission. Returns false when the view is not ours. */
  async onViewSubmission(interaction: SlackInteraction): Promise<boolean> {
    const view = interaction.view;
    if (view?.callback_id !== CWD_VIEW) return false;
    const key: ConversationKey = {
      channelId: "slack",
      conversationId: view.private_metadata ?? "",
    };
    await this.startSessionIn(key, (view.state?.values?.[CWD_BLOCK]?.[CWD_INPUT]?.value ?? "").trim());
    return true;
  }
}
