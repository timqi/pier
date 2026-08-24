// How a reply looks on Lark: an interactive card whose body is a markdown
// element, buttons as flow columns, and the turn footer as notation-sized grey
// text.
//
// Everything is a card, never a plain `text` message, because three checklist
// features live or die on it: buttons (next-step suggestions, the settings
// panel), edit-in-place (the panel's one-message contract, via message.patch),
// and the muted footer. The costs are known and accepted: the chat list
// previews a card as「卡片」rather than its first line, and card interactions
// expire after 30 days — fine for buttons that answer the turn they rode on.
//
// The markdown element takes the agent's markdown near-unmodified — Lark's
// dialect covers emphasis, fences, lists, links and quotes — so unlike
// Telegram (HTML) and Slack's mrkdwn fallback there is no translation layer,
// and no escaping either: Lark treats what it cannot parse as literal text
// rather than rejecting the message (avibe ships the same identity escape).

import { balanceFences, chunkText } from "./chunk.js";
import type {
  LarkActionValue,
  LarkButton,
  LarkCard,
  LarkElement,
  LarkFormInput,
} from "./lark-api.js";

/**
 * Chunk budget in characters. The binding limit is the card's 30KB request
 * cap in *bytes*; a CJK character spends three, plus JSON string overhead, so
 * 7000 chars keeps the worst all-CJK turn near 21KB with room for the card
 * scaffolding around it.
 */
export const LARK_MAX = 7000;
// Lark truncates a button label around this, mid-word.
const BUTTON_MAX = 60;

/**
 * Cut at the last break that fits, then re-balance code fences across the cut:
 * Lark, like Slack, lets an unterminated ``` swallow the rest of the message.
 */
export const chunk = (text: string, max: number): string[] =>
  balanceFences(chunkText(text, max));

/** The body of a turn, rendered by Lark's own markdown dialect. */
export const markdown = (content: string): LarkElement => ({ tag: "markdown", content });

/**
 * Small muted text. Card schema 2.0 removed the `note` component; its
 * replacement is a notation-sized markdown element, and the grey must come
 * from the inline font tag because 2.0's markdown element rejects a
 * `text_color` property. Both verified against the live API (by avibe).
 *
 * Standalone cards only (a quiet turn, an options row): beside a body it
 * would render a blank gap — elements space themselves apart and no spacing
 * knob is documented — so there the footer folds into the body's own element
 * (`withFooter`), where a newline is just a newline.
 */
export const footer = (content: string): LarkElement => ({
  tag: "markdown",
  content: `<font color='grey'>${content}</font>`,
  text_size: "notation",
});

/**
 * Markdown constructs a following line *continues* instead of leaving: a list
 * item, a blockquote, a table row. After one of these a single newline is
 * lazy continuation — the footer rendered glued onto "5. 麻辣烫：…" in the
 * field — so the footer needs the blank line that ends the construct. After a
 * plain paragraph the single newline stays, because that is the tight spacing
 * this helper exists for.
 */
const LAZY_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/;

/** A body and its footer in one markdown element — grey, gapless. */
export const withFooter = (body: string, note: string): LarkElement => {
  const last = body.trimEnd().split("\n").at(-1) ?? "";
  const brk = LAZY_LINE.test(last) ? "\n\n" : "\n";
  return markdown(`${body}${brk}<font color='grey'>${note}</font>`);
};

const truncate = (label: string): string =>
  label.length > BUTTON_MAX ? `${label.slice(0, BUTTON_MAX - 1)}\u2026` : label;

export const button = (label: string, value: LarkActionValue): LarkButton => ({
  tag: "button",
  text: { tag: "plain_text", content: truncate(label) },
  type: "default",
  behaviors: [{ type: "callback", value }],
});

/**
 * One row of buttons as a `flow` column set: each column sizes to its button
 * and the row wraps on narrow screens, so a long label beside a short one
 * costs nothing (the same property Slack's actions row has natively).
 */
export const buttonRow = (buttons: LarkButton[]): LarkElement => ({
  tag: "column_set",
  flex_mode: "flow",
  background_style: "default",
  columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
});

export const card = (elements: LarkElement[]): LarkCard => ({
  schema: "2.0",
  body: { direction: "vertical", elements },
});

/** A typed answer inside a card — Lark's stand-in for a modal. */
export const formInput = (
  name: string,
  label: string,
  placeholder: string,
): LarkFormInput => ({
  tag: "input",
  name,
  required: true,
  label: { tag: "plain_text", content: label },
  placeholder: { tag: "plain_text", content: placeholder },
});

// --- next-step buttons -----------------------------------------------------------

/**
 * The callback value carries the key (`sg:0`) *and* the label. On Slack the
 * label is read back off the message the platform echoes with the click; Lark
 * echoes only the value, and `message.get` cannot return a 2.0 card at all
 * (see LarkActionValue), so the value is this platform's "read it back off
 * the message" — still platform state, never adapter memory, so a button
 * survives a restart and the Console's reload the same way (avibe ships the
 * label in the value too: `quick_reply:<label>`).
 */
export const OFFER_PREFIX = "sg:";

/** The card minus its button rows — how taken options are retired. */
export const withoutButtons = (cardIn: LarkCard): LarkCard =>
  card(cardIn.body.elements.filter((el) => el.tag !== "column_set" && el.tag !== "button"));
