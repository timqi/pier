// How a reply looks on Lark: an interactive card whose body is a markdown
// element. Always a card, never plain `text`: buttons, edit-in-place and the
// muted footer all need one. Costs accepted: the chat list previews a card as
// 「卡片」, and card interactions expire after 30 days. Lark's markdown dialect
// takes the agent's markdown near-unmodified and treats what it cannot parse as
// literal text, so there is no translation and no escaping.

import { cut } from "../core/reply.js";
import { balanceFences, chunkText } from "./chunk.js";
import type {
  LarkActionValue,
  LarkButton,
  LarkCard,
  LarkElement,
  LarkFormInput,
} from "./lark-api.js";

/** The binding limit is the card's 30KB request cap in bytes; a CJK character
 *  spends three, so 7000 chars keeps an all-CJK turn near 21KB plus scaffolding. */
export const LARK_MAX = 7000;
// Lark truncates a button label around this, mid-word.
const BUTTON_MAX = 60;

/** Fences re-balanced across the cut: an unterminated ``` swallows the rest. */
export const chunk = (text: string, max: number): string[] =>
  balanceFences(chunkText(text, max));

export const markdown = (content: string): LarkElement => ({ tag: "markdown", content });

/** Schema 2.0 has no `note`, and its markdown element rejects `text_color`, so
 *  the grey is an inline font tag. Standalone cards only: beside a body it
 *  renders a blank gap, so there the footer folds into the body (`withFooter`). */
export const footer = (content: string): LarkElement => ({
  tag: "markdown",
  content: `<font color='grey'>${content}</font>`,
  text_size: "notation",
});

/** After a list item, a quote or a table row a single newline is lazy
 *  continuation and the footer glues onto the line; those need a blank line. */
const LAZY_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/;

export const withFooter = (body: string, note: string): LarkElement => {
  const last = body.trimEnd().split("\n").at(-1) ?? "";
  const brk = LAZY_LINE.test(last) ? "\n\n" : "\n";
  return markdown(`${body}${brk}<font color='grey'>${note}</font>`);
};

const truncate = (label: string): string => cut(label, BUTTON_MAX);

export const button = (label: string, value: LarkActionValue): LarkButton => ({
  tag: "button",
  text: { tag: "plain_text", content: truncate(label) },
  type: "default",
  behaviors: [{ type: "callback", value }],
});

/** A `flow` column set sizes each column to its button and wraps on narrow screens. */
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

/** Lark's stand-in for a modal. */
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

/** The value carries the key and the label: Lark echoes only the value, and
 *  `message.get` cannot return a 2.0 card (LarkActionValue), so this is the one
 *  place a button's meaning survives a restart. */
export const OFFER_PREFIX = "sg:";

export const withoutButtons = (cardIn: LarkCard): LarkCard =>
  card(cardIn.body.elements.filter((el) => el.tag !== "column_set" && el.tag !== "button"));
