// Slack's half of the settings panel (panel.ts has the rest). Every button's
// `value` and the modal's `private_metadata` carry the draft with the card's
// coordinates, so a click or a submission after a reload is understood from
// the payload alone and lands on the message the user is looking at.

import type { ConversationKey } from "../core/types.js";
import {
  ChatPanel,
  CWD_DRAFT_TAIL,
  CWD_PLACEHOLDER,
  CWD_TAIL,
  PANEL_PREFIX,
  type PanelButton,
  type PanelDeps,
  type PanelDraft,
  type PanelState,
  type PanelView,
  readDraft,
  serializeDraft,
} from "./panel.js";
import type { SlackBlock, SlackButton, SlackClient, SlackInteraction } from "./slack-api.js";
import { context, escapeMrkdwn as esc, section } from "./slack-render.js";
import { chatOf } from "./types.js";

const CWD_VIEW = "cfg_cwd";
const CWD_BLOCK = "cwd_block";
const CWD_INPUT = "cwd_input";

export interface SlackPanelDeps extends PanelDeps {
  api: Pick<SlackClient, "postMessage" | "updateMessage" | "deleteMessage" | "openView">;
}

interface SlackPanelState extends PanelState {
  /** The panel message. */
  ts: string;
}

/** What the modal carries: where its answer is drawn, and the draft it amends. */
interface CwdMetadata {
  conversation: string;
  ts: string;
  draft?: string;
}

const button = (b: PanelButton, value: string | undefined): SlackButton => ({
  type: "button",
  action_id: `${PANEL_PREFIX}${b.action}`,
  text: { type: "plain_text", text: b.label, emoji: true },
  ...(value ? { value } : {}),
});

const row = (buttons: PanelButton[], value: string | undefined): SlackBlock => ({
  type: "actions",
  elements: buttons.map((b) => button(b, value)),
});

const fresh = (channel: string, ts: string, draft: PanelDraft): SlackPanelState =>
  ({ chatId: channel, ts, draft, dirs: [], sessions: [] });

export class SlackPanel extends ChatPanel<SlackPanelState, SlackInteraction> {
  protected readonly platform = "slack" as const;
  protected readonly fence: [string, string] = ["`", "`"];

  constructor(protected override readonly deps: SlackPanelDeps) {
    super(deps);
  }

  protected esc(text: string): string {
    return esc(text);
  }

  /** A malformed value is a stale or foreign card: logged, drawn as an empty draft. */
  private parseDraft(raw: string | undefined): PanelDraft {
    if (!raw) return {};
    try {
      return readDraft(JSON.parse(raw));
    } catch (err) {
      this.deps.log(`unreadable panel value, draft reset: ${String(err)}`);
      return {};
    }
  }

  // --- rendering -------------------------------------------------------------

  private blocks(view: PanelView, draft: PanelDraft, note?: string): SlackBlock[] {
    const value = serializeDraft(draft);
    return [
      ...view.groups.map((g) => section([`*${g.title}*${g.suffix ?? ""}`, ...g.lines].join("\n"))),
      ...(view.picks?.length ? [row(view.picks, value)] : []),
      ...view.rows.filter((r) => r.length).map((r) => row(r, value)),
      ...(note ? [context(esc(note))] : []),
    ];
  }

  async open(key: ConversationKey, channel: string, threadTs: string, question?: string): Promise<void> {
    const { draft, note } = this.opening(key, question);
    const state = fresh(channel, "", draft);
    const sent = await this.deps.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Settings",
      blocks: this.blocks(await this.view(key, state), draft, note),
    });
    this.remember(key, { ...state, ts: sent.ts });
  }

  protected async draw(state: SlackPanelState, view: PanelView, note?: string): Promise<void> {
    await this.deps.api.updateMessage({
      channel: state.chatId,
      ts: state.ts,
      text: "Settings",
      blocks: this.blocks(view, state.draft, note),
    }).catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  protected async erase(state: SlackPanelState): Promise<void> {
    await this.deps.api.deleteMessage(state.chatId, state.ts)
      .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
  }

  // --- actions ---------------------------------------------------------------

  /** Returns false when the action is not ours. `run` delivers Start's
   *  question as the clicker's message. */
  async onAction(
    interaction: SlackInteraction,
    key: ConversationKey,
    actionId: string,
    run: (text: string) => Promise<void>,
  ): Promise<boolean> {
    return this.dispatch(
      key,
      actionId,
      interaction,
      () =>
        fresh(
          interaction.channel?.id ?? chatOf(key.conversationId),
          interaction.message?.ts ?? "",
          this.parseDraft(interaction.actions?.[0]?.value),
        ),
      run,
    );
  }

  // --- working directory (one typed answer, in a modal) ----------------------

  protected async promptCwd(
    key: ConversationKey,
    state: SlackPanelState,
    interaction: SlackInteraction,
    creates: boolean,
  ): Promise<void> {
    const trigger = interaction.trigger_id;
    if (!trigger) {
      await this.refresh(key, "Could not open the dialog — try again.");
      return;
    }
    const metadata: CwdMetadata = { conversation: key.conversationId, ts: state.ts, draft: serializeDraft(state.draft) };
    await this.deps.api.openView(trigger, {
      type: "modal",
      callback_id: CWD_VIEW,
      private_metadata: JSON.stringify(metadata),
      title: { type: "plain_text", text: creates ? "New session" : "Directory" },
      submit: { type: "plain_text", text: creates ? "Create" : "Set" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: CWD_BLOCK,
          label: { type: "plain_text", text: "Working directory" },
          hint: { type: "plain_text", text: `An absolute path. ${creates ? CWD_TAIL : CWD_DRAFT_TAIL}` },
          element: {
            type: "plain_text_input",
            action_id: CWD_INPUT,
            placeholder: { type: "plain_text", text: CWD_PLACEHOLDER },
          },
        },
      ],
    }).catch((err) => this.deps.log(`cwd modal failed: ${String(err)}`));
  }

  /** Consume a modal submission. Returns false when the view is not ours. */
  async onViewSubmission(interaction: SlackInteraction): Promise<boolean> {
    const view = interaction.view;
    if (view?.callback_id !== CWD_VIEW) return false;
    let meta: CwdMetadata;
    try {
      meta = JSON.parse(view.private_metadata ?? "") as CwdMetadata;
    } catch (err) {
      this.deps.log(`cwd modal without readable metadata, dropped: ${String(err)}`);
      return true;
    }
    const key: ConversationKey = { channelId: "slack", conversationId: meta.conversation };
    if (!this.state(key)) this.remember(key, fresh(chatOf(meta.conversation), meta.ts, this.parseDraft(meta.draft)));
    await this.startSessionIn(key, (view.state?.values?.[CWD_BLOCK]?.[CWD_INPUT]?.value ?? "").trim());
    return true;
  }
}
