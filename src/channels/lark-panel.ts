// Lark's half of the settings panel: card markup, flow button rows, and a form
// card for the one typed answer. The panel itself lives in `panel.ts`.
//
// Lark has no modal a WebSocket app can open — a "modal" here is the panel
// message patched into a form card (an input plus a submit button), which is
// avibe's verified pattern. The submit button's `name` carries the thread root
// the same way every other panel button's callback value does, so a submission
// needs no adapter-side state to find its conversation — the map below only
// remembers where the panel message itself lives.

import type { ConversationKey } from "../core/types.js";
import type { LarkCard, LarkCardAction, LarkClient, LarkElement } from "./lark-api.js";
import {
  button as cardButton,
  buttonRow,
  card,
  footer,
  formInput,
  markdown,
} from "./lark-render.js";
import {
  ChatPanel,
  CWD_PLACEHOLDER,
  CWD_TAIL,
  PANEL_PREFIX,
  type PanelButton,
  type PanelDeps,
  type PanelState,
  type PanelView,
} from "./panel.js";

/** A form-submit button name: `cwdgo:<thread root>`. */
export const CWD_SUBMIT_PREFIX = "cwdgo:";
/** The form input's field name, the key `form_value` answers under. */
export const CWD_FIELD = "cwd";

export interface LarkPanelDeps extends PanelDeps {
  api: Pick<LarkClient, "replyCard" | "patchCard" | "deleteMessage">;
}

/** Where this conversation's panel lives. */
interface LarkPanelState extends PanelState {
  /** The thread root every panel button needs in its callback value. */
  root: string;
  messageId: string;
}

export class LarkPanel extends ChatPanel<LarkPanelState, LarkCardAction> {
  protected readonly platform = "lark" as const;
  protected readonly fence: [string, string] = ["`", "`"];

  constructor(protected override readonly deps: LarkPanelDeps) {
    super(deps);
  }

  /** Lark's markdown treats what it cannot parse as literal text; there is no
   *  escape syntax to apply (see lark-render.ts). */
  protected esc(text: string): string {
    return text;
  }

  // --- rendering -------------------------------------------------------------

  private btn(b: PanelButton, root: string) {
    return cardButton(b.label, { key: `${PANEL_PREFIX}${b.action}`, root });
  }

  private render(view: PanelView, root: string, note?: string): LarkCard {
    const elements: LarkElement[] = [
      ...view.groups.map((g) =>
        markdown([`**${g.title}**${g.suffix ?? ""}`, ...g.lines].join("\n"))),
      // A flow row wraps, so a page of models lays out like Slack's one row.
      ...(view.picks?.length ? [buttonRow(view.picks.map((p) => this.btn(p, root)))] : []),
      ...view.rows.filter((r) => r.length).map((row) =>
        buttonRow(row.map((b) => this.btn(b, root)))),
    ];
    if (note) elements.push(footer(note));
    return card(elements);
  }

  /** Open a fresh panel, replacing whichever one this conversation had. */
  async open(key: ConversationKey, chatId: string, root: string): Promise<void> {
    const sent = await this.deps.api.replyCard(root, this.render(await this.view(key, chatId), root));
    this.remember(key, { chatId, root, messageId: sent.messageId, models: [] });
  }

  protected async draw(state: LarkPanelState, view: PanelView, note?: string): Promise<void> {
    await this.deps.api.patchCard(state.messageId, this.render(view, state.root, note))
      .catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  protected async erase(state: LarkPanelState): Promise<void> {
    await this.deps.api.deleteMessage(state.messageId)
      .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
  }

  // --- actions ---------------------------------------------------------------

  /**
   * Handle a `cfg:` click. Returns false when the action is not ours, so the
   * caller can treat it as one of the agent's next-step labels instead.
   */
  async onAction(
    action: LarkCardAction,
    key: ConversationKey,
    payload: string,
    root: string,
  ): Promise<boolean> {
    return this.dispatch(key, payload, action, () => this.open(key, action.chatId, root));
  }

  // --- working directory (one typed answer, in a form card) -------------------

  protected async promptCwd(
    key: ConversationKey,
    state: LarkPanelState,
    _action: LarkCardAction,
  ): Promise<void> {
    const form: LarkElement = {
      tag: "form",
      name: "cwd_form",
      elements: [
        formInput(CWD_FIELD, "Working directory", CWD_PLACEHOLDER),
        markdown(`An absolute path. ${CWD_TAIL}`),
        {
          tag: "button",
          text: { tag: "plain_text", content: "Start" },
          type: "primary",
          action_type: "form_submit",
          name: `${CWD_SUBMIT_PREFIX}${state.root}`,
        },
      ],
    };
    await this.deps.api.patchCard(
      state.messageId,
      card([form, buttonRow([this.btn({ label: "Cancel", action: "panel" }, state.root)])]),
    ).catch((err) => this.deps.log(`cwd form failed: ${String(err)}`));
  }

  /**
   * Consume a form submission. The adapter routes any `cwdgo:` submit here;
   * a panel that outlived its process is re-remembered from the event itself,
   * so the outcome still lands on the card the user is looking at.
   */
  async onCwdSubmit(key: ConversationKey, action: LarkCardAction, root: string): Promise<void> {
    if (!this.state(key)) {
      this.remember(key, { chatId: action.chatId, root, messageId: action.messageId, models: [] });
    }
    await this.startSessionIn(key, String(action.formValue?.[CWD_FIELD] ?? "").trim());
  }
}
