// How a reply looks on Slack: mrkdwn text, and buttons as a Block Kit
// `actions` row. mrkdwn is not markdown (`*bold*`, `_italic_`, `~strike~`,
// `<url|label>`), so the agent's markdown is translated; Slack degrades unknown
// syntax to literal text rather than rejecting the message.

import { cut } from "../core/reply.js";
import { balanceFences, chunkText } from "./chunk.js";
import type { SlackBlock, SlackButton } from "./slack-api.js";

/** Slack caps `markdown` blocks at 12,000 cumulative chars per message. */
export const MARKDOWN_MAX = 11_000;
/** A `section` block's text caps at 3000, and the mrkdwn translation adds markup. */
export const MRKDWN_MAX = 2800;
// Slack truncates a button label past this, mid-word.
const BUTTON_MAX = 75;

export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** mrkdwn spells bold with the single star markdown uses for italic, so bold
 *  is marked with a sentinel until the italic pass has run. */
const BOLD = "\uE002";

function inline(text: string): string {
  return text
    // Links first: their label may itself carry emphasis.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      `<${url}|${label}>`)
    // Bold before italic: `**x**` must not be seen as two `*x*` runs.
    .replace(/\*\*([^\n*]+)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/~~([^\n~]+)~~/g, "~$1~")
    .replace(/(^|[\s(])[*_]([^\n*_]+)[*_](?=[\s).,!?:;]|$)/g, "$1_$2_")
    .replace(/^#{1,6}[ \t]+(.+)$/gm, `${BOLD}$1${BOLD}`)
    // Slack renders neither `-` nor `*` as a list marker.
    .replace(/^[ \t]*[-*+][ \t]+/gm, "\u2022 ")
    .replaceAll(BOLD, "*");
}

/** Code is stashed before escaping so emphasis inside it stays literal. */
export function toMrkdwn(markdown: string): string {
  const stash: string[] = [];
  const keep = (text: string): string => `\uE000${stash.push(text) - 1}\uE001`;

  // Slack fences carry no language; the hint would show as the first line.
  let out = markdown.replace(/```[\w.+-]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    keep("```\n" + escapeMrkdwn(code.replace(/\n+$/, "")) + "\n```"));
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`\`${escapeMrkdwn(code)}\``));
  out = inline(escapeMrkdwn(out));
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => stash[Number(i)] ?? "");
}

export const chunk = (text: string, max: number): string[] =>
  balanceFences(chunkText(text, max));

/** Slack's own renderer: tables and headers survive, and the client never
 *  folds it behind "Show more". */
export const markdown = (text: string): SlackBlock => ({ type: "markdown", text });

export const section = (text: string): SlackBlock => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

// Slack caps a message at 50 blocks; the footer and the button row need two.
const MAX_BLOCKS = 45;
// A section block's hard limit; only the overflow merge in sections() can reach it.
const SECTION_MAX = 2900;

/** Never cuts a fenced block: a fence split across two blocks leaves both unbalanced. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (buf.length) out.push(buf.join("\n"));
    buf = [];
  };
  for (const line of text.split("\n")) {
    const isFence = line.trimStart().startsWith("```");
    if (!fenced && !isFence && !line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
    if (isFence) {
      fenced = !fenced;
      if (!fenced) flush();
    }
  }
  flush();
  return out;
}

/** The fallback for a workspace that refuses the `markdown` block. One section
 *  per paragraph, never packed: a tall single block is collapsed behind "Show
 *  more", several short ones render unfolded. */
export function sections(text: string): SlackBlock[] {
  const paras = paragraphs(text);
  if (!paras.length) return [];
  // The tail is folded into the last block, not dropped.
  const kept = paras.slice(0, MAX_BLOCKS - 1);
  const tail = paras.slice(MAX_BLOCKS - 1);
  if (tail.length) kept.push(tail.join("\n\n").slice(0, SECTION_MAX));
  return kept.map(section);
}

/** Slack's small muted text, for the footer. */
export const context = (text: string): SlackBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

// --- next-step buttons -------------------------------------------------------

/** `action_id` carries an index: the label is read back off the message Slack
 *  echoes with the click, so a button survives a reload. */
export const OFFER_PREFIX = "sg:";

/** Slack refuses a button label over BUTTON_MAX: every button, the panel's too. */
export const truncate = (label: string): string => cut(label, BUTTON_MAX);

/** Slack wraps buttons on its own, so there is no row packing to budget. */
export function actions(labels: string[]): SlackBlock | undefined {
  if (!labels.length) return undefined;
  const elements: SlackButton[] = labels.map((label, index) => ({
    type: "button",
    action_id: `${OFFER_PREFIX}${index}`,
    text: { type: "plain_text", text: truncate(label), emoji: true },
  }));
  return { type: "actions", elements };
}

export function offeredLabel(
  blocks: SlackBlock[] | undefined,
  actionId: string,
): string | undefined {
  if (!actionId.startsWith(OFFER_PREFIX)) return undefined;
  for (const block of blocks ?? []) {
    if (block.type !== "actions") continue;
    const hit = block.elements.find((el) => el.action_id === actionId);
    if (hit) return hit.text.text;
  }
  return undefined;
}
