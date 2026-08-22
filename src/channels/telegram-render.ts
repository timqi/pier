import { chunkText } from "./chunk.js";
import type { InlineKeyboard, TgMessage } from "./telegram-api.js";

// How a reply looks on Telegram: text and buttons.
//
// Markdown → Telegram Bot API HTML. Telegram's parser accepts a tiny tag set
// and rejects the whole message on anything else, so we escape first and
// reintroduce exactly the tags it documents: b, i, s, code, pre, a.
// Unsupported markdown (tables, images, nested lists) degrades to plain text
// rather than losing the message.

const MAX_CHARS = 3800; // Telegram's hard limit is 4096; leave room for tags.

/** Shared: the adapter and the panel escape plain text with this too. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline emphasis, applied after escaping so `<b>` can only come from us. */
function inline(text: string): string {
  return text
    // Links first: their label may itself carry emphasis.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>")
    .replace(/~~([^\n~]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])[*_]([^\n*_]+)[*_](?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    // Headings carry no size in Telegram; bold is the closest honest render.
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
}

/**
 * Render one assistant turn. Code spans and fences are extracted before
 * escaping so emphasis inside them stays literal.
 */
export function toTelegramHtml(markdown: string): string {
  const stash: string[] = [];
  // Private-use sentinels: markdown can't contain them, so a stashed block
  // can't be re-matched by the escaping and emphasis passes that follow.
  const keep = (html: string): string => `\uE000${stash.push(html) - 1}\uE001`;

  let out = markdown.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) =>
    keep(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n+$/, ""))}</code></pre>`
        : `<pre>${escapeHtml(code.replace(/\n+$/, ""))}</pre>`,
    ));
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  out = inline(escapeHtml(out));
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => stash[Number(i)] ?? "");
}

/**
 * Split rendered HTML into sendable chunks. A turn long enough to need this can
 * still be cut inside a <pre> block; Telegram closes the tag on its own and the
 * text survives, which beats dropping the turn. (Slack cannot do that, which is
 * why its renderer re-balances fences after the cut.)
 */
export const chunk = (html: string): string[] => chunkText(html, MAX_CHARS);

// --- next-step buttons -------------------------------------------------------

/**
 * Telegram caps `callback_data` at 64 *bytes* — about 21 CJK characters, far
 * too little to carry a label. Buttons send an index instead, and the label is
 * read back off the message's own keyboard.
 */
export const OFFER_PREFIX = "sg:";
// Buttons in one row share the row's width, so packing is budgeted by display
// width rather than count: a CJK glyph takes about twice an ASCII one.
const ROW_WIDTH = 26;
const ROW_BUTTONS = 3;

/** Rough rendered width: CJK, fullwidth punctuation and emoji take two cells. */
const displayWidth = (label: string): number =>
  [...label].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);

/**
 * Pack short labels onto shared rows, keeping the offered order. A row that is
 * already wide stops accepting: buttons in one Telegram row split the width
 * evenly, so squeezing a long label in truncates everything beside it.
 */
export function keyboard(labels: string[]): InlineKeyboard | undefined {
  if (!labels.length) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  let used = 0;
  labels.forEach((label, index) => {
    const width = displayWidth(label);
    const row = rows.at(-1);
    const button = { text: label, callback_data: `${OFFER_PREFIX}${index}` };
    if (!row || row.length >= ROW_BUTTONS || used + width > ROW_WIDTH) {
      rows.push([button]);
      used = width;
      return;
    }
    row.push(button);
    used += width;
  });
  return { inline_keyboard: rows };
}

/**
 * The label a next-step payload stands for. Read off the tapped message's own
 * keyboard, which Telegram echoes back — so a button keeps working across a
 * restart or a config reload, where an in-memory offer list would not.
 * A payload we never wrote (an older label-as-payload button) passes through.
 */
export function offeredLabel(msg: TgMessage, data: string): string | undefined {
  if (!data.startsWith(OFFER_PREFIX)) return data;
  return msg.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.callback_data === data)
    ?.text;
}
