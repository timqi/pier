// Lark's half of the settings panel (panel.ts has the rest). Lark has no modal
// a WebSocket app can open, so the typed answer is the panel patched into a
// form card; the submit button's `name` carries the thread root. Every callback
// button's value carries the draft, so a tap after a reload is understood from
// the payload and lands on the card it came from.

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
} from "./panel.js";

/** A form-submit button name: `cwdgo:<thread root>`. */
export const CWD_SUBMIT_PREFIX = "cwdgo:";
const CWD_FIELD = "cwd";

export interface LarkPanelDeps extends PanelDeps {
  api: Pick<LarkClient, "replyCard" | "patchCard" | "deleteMessage">;
}

interface LarkPanelState extends PanelState {
  root: string;
  messageId: string;
}

const fresh = (chatId: string, root: string, messageId: string, draft: PanelDraft): LarkPanelState =>
  ({ chatId, root, messageId, draft, dirs: [], sessions: [] });

export class LarkPanel extends ChatPanel<LarkPanelState, LarkCardAction> {
  protected readonly platform = "lark" as const;
  protected readonly fence: [string, string] = ["`", "`"];

  constructor(protected override readonly deps: LarkPanelDeps) {
    super(deps);
  }

  /** Lark's markdown has no escape syntax (lark-render.ts). */
  protected esc(text: string): string {
    return text;
  }

  // --- rendering -------------------------------------------------------------

  private btn(b: PanelButton, state: Pick<LarkPanelState, "root" | "draft">) {
    const draft = Object.keys(state.draft).length ? { draft: state.draft } : {};
    return cardButton(b.label, { key: `${PANEL_PREFIX}${b.action}`, root: state.root, ...draft });
  }

  private render(view: PanelView, state: Pick<LarkPanelState, "root" | "draft">, note?: string): LarkCard {
    const elements: LarkElement[] = [
      ...view.groups.map((g) =>
        markdown([`**${g.title}**${g.suffix ?? ""}`, ...g.lines].join("\n"))),
      ...(view.picks?.length ? [buttonRow(view.picks.map((p) => this.btn(p, state)))] : []),
      ...view.rows.filter((r) => r.length).map((row) =>
        buttonRow(row.map((b) => this.btn(b, state)))),
    ];
    if (note) elements.push(footer(note));
    return card(elements);
  }

  async open(key: ConversationKey, chatId: string, root: string, question?: string): Promise<void> {
    const { draft, note } = this.opening(key, question);
    const state = fresh(chatId, root, "", draft);
    const sent = await this.deps.api.replyCard(root, this.render(await this.view(key, state), state, note));
    this.remember(key, { ...state, messageId: sent.messageId });
  }

  protected async draw(state: LarkPanelState, view: PanelView, note?: string): Promise<void> {
    await this.deps.api.patchCard(state.messageId, this.render(view, state, note))
      .catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  protected async erase(state: LarkPanelState): Promise<void> {
    await this.deps.api.deleteMessage(state.messageId)
      .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
  }

  // --- actions ---------------------------------------------------------------

  /** Returns false when the action is not ours. `run` delivers Start's
   *  question as the tapper's message. */
  async onAction(
    action: LarkCardAction,
    key: ConversationKey,
    payload: string,
    root: string,
    run: (text: string) => Promise<void>,
  ): Promise<boolean> {
    return this.dispatch(
      key,
      payload,
      action,
      () => fresh(action.chatId, root, action.messageId, readDraft(action.value?.draft)),
      run,
    );
  }

  // --- working directory (one typed answer, in a form card) -------------------

  protected async promptCwd(
    key: ConversationKey,
    state: LarkPanelState,
    _action: LarkCardAction,
    creates: boolean,
  ): Promise<void> {
    const form: LarkElement = {
      tag: "form",
      name: "cwd_form",
      elements: [
        formInput(CWD_FIELD, "Working directory", CWD_PLACEHOLDER),
        markdown(`An absolute path. ${creates ? CWD_TAIL : CWD_DRAFT_TAIL}`),
        {
          tag: "button",
          text: { tag: "plain_text", content: creates ? "Create" : "Set" },
          type: "primary",
          action_type: "form_submit",
          name: `${CWD_SUBMIT_PREFIX}${state.root}`,
        },
      ],
    };
    await this.deps.api.patchCard(
      state.messageId,
      card([form, buttonRow([this.btn({ label: "Cancel", action: "panel" }, state)])]),
    ).catch((err) => this.deps.log(`cwd form failed: ${String(err)}`));
  }

  /** A panel that outlived its process is re-remembered from the event, so
   *  the outcome lands on the card the user is looking at. The submit button
   *  carries no value, so a draft's earlier picks do not survive that restart. */
  async onCwdSubmit(key: ConversationKey, action: LarkCardAction, root: string): Promise<void> {
    if (!this.state(key)) this.remember(key, fresh(action.chatId, root, action.messageId, {}));
    await this.startSessionIn(key, String(action.formValue?.[CWD_FIELD] ?? "").trim());
  }
}
