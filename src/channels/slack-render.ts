// How a reply looks on Slack: mrkdwn text, and buttons as a Block Kit
// `actions` row.
//
// mrkdwn is not markdown. Bold is `*one*` star, italic is `_underscore_`,
// strikethrough is `~one~` tilde, and a link is `<url|label>` — so the agent's
// markdown has to be translated, not passed through. Only `&`, `<` and `>` are
// escaped; unlike Telegram's HTML parser Slack degrades unknown syntax to
// literal text instead of rejecting the message, so the risk here is an ugly
// reply rather than a lost one.

import { chunkText } from "./chunk.js";
import type { SlackBlock, SlackButton } from "./slack-api.js";

/**
 * A `markdown` block's budget: Slack caps them at 12,000 cumulative chars per
 * message, and one message carries one. This is the normal path.
 */
export const MARKDOWN_MAX = 11_000;
/**
 * The legacy fallback's budget: a `section` block's text caps at 3000, and the
 * mrkdwn translation adds a little markup.
 */
export const MRKDWN_MAX = 2800;
// Slack truncates a button label past this, mid-word.
const BUTTON_MAX = 75;

/** Shared: the adapter and the panel escape plain text with this too. */
export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Inline emphasis, applied after escaping so our own markup stays ours.
 *
 * Bold is marked with a private-use sentinel rather than written as `*` right
 * away: mrkdwn spells bold with the single star that markdown uses for italic,
 * so emitting it early would let the italic pass eat it again.
 */
const BOLD = "\uE002";

function inline(text: string): string {
  return text
    // Links first: their label may itself carry emphasis. Slack inverts the
    // order of markdown's pair, and `>` inside is already escaped.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      `<${url}|${label}>`)
    // Bold before italic: `**x**` must not be seen as two `*x*` runs.
    .replace(/\*\*([^\n*]+)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/~~([^\n~]+)~~/g, "~$1~")
    .replace(/(^|[\s(])[*_]([^\n*_]+)[*_](?=[\s).,!?:;]|$)/g, "$1_$2_")
    // Headings have no size in Slack either; bold is the closest honest render.
    .replace(/^#{1,6}[ \t]+(.+)$/gm, `${BOLD}$1${BOLD}`)
    // Slack renders neither `-` nor `*` as a list marker, so bullets are drawn.
    .replace(/^[ \t]*[-*+][ \t]+/gm, "\u2022 ")
    .replaceAll(BOLD, "*");
}

/**
 * Render one assistant turn as mrkdwn. Code spans and fences are extracted
 * before escaping so emphasis inside them stays literal.
 */
export function toMrkdwn(markdown: string): string {
  const stash: string[] = [];
  // Private-use sentinels: markdown cannot contain them, so a stashed block
  // cannot be re-matched by the escaping and emphasis passes that follow.
  const keep = (text: string): string => `\uE000${stash.push(text) - 1}\uE001`;

  // Slack code fences carry no language, so the hint is dropped rather than
  // shown as the first line of the block.
  let out = markdown.replace(/```[\w.+-]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    keep("```\n" + escapeMrkdwn(code.replace(/\n+$/, "")) + "\n```"));
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`\`${escapeMrkdwn(code)}\``));
  out = inline(escapeMrkdwn(out));
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => stash[Number(i)] ?? "");
}

/**
 * Split rendered mrkdwn into sendable chunks at the last blank line or newline
 * that fits, then re-balance code fences across the cut.
 *
 * Telegram can be cut mid-`<pre>` and shrug — its parser closes the tag itself.
 * Slack does not: an unterminated ``` swallows the rest of that message, and
 * the next chunk starts *outside* a fence, so the tail of a long code block
 * renders as prose. Closing and reopening around the boundary is what keeps a
 * split code block readable.
 */
export const chunk = (text: string, max: number): string[] =>
  balanceFences(chunkText(text, max));

/**
 * Close a fence a chunk left open, and reopen it on the next one. Counting `\`
 * runs is enough because `toMrkdwn` has already normalised every fence to a
 * bare ``` on its own line.
 */
function balanceFences(parts: string[]): string[] {
  let open = false;
  return parts.map((part) => {
    const reopened = open ? `\`\`\`\n${part}` : part;
    // The prepended fence counts too, so a chunk that closes the block it
    // inherited comes out even and clears the flag.
    open = ((reopened.match(/```/g) ?? []).length % 2) === 1;
    return open ? `${reopened}\n\`\`\`` : reopened;
  });
}

/**
 * The body of a turn, as Slack's own markdown renderer sees it. Preferred over
 * `section` for everything the agent wrote: it takes the markdown unmodified
 * (so tables and headers survive) and the client never folds it behind
 * "Show more".
 */
export const markdown = (text: string): SlackBlock => ({ type: "markdown", text });

export const section = (text: string): SlackBlock => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

// Slack caps a message at 50 blocks; the footer and the button row need two.
const MAX_BLOCKS = 45;
// A section block's hard limit. Nothing should reach it — chunk() caps a whole
// message below this — but the overflow merge below could in principle.
const SECTION_MAX = 2900;

/**
 * Split rendered mrkdwn into paragraphs without ever cutting a fenced code
 * block — a fence split across two blocks would leave both unbalanced, the
 * same hazard `chunk()` handles for messages.
 */
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
    // A blank line only ends a paragraph outside a fence; inside one it is code.
    if (!fenced && !isFence && !line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
    if (isFence) {
      fenced = !fenced;
      // A closed fence stands alone, so it can never be merged apart.
      if (!fenced) flush();
    }
  }
  flush();
  return out;
}

/**
 * The body of one message as one `section` block per paragraph — the fallback
 * for a workspace whose Slack refuses the `markdown` block.
 *
 * A whole turn in a single section block gets collapsed behind "Show more",
 * hiding most of the answer; several blocks render unfolded. Paragraphs are
 * deliberately *not* packed together to fill a size budget — a paragraph is
 * already the natural short unit, and merging a few of them back into one tall
 * block is exactly what brings the collapse back.
 */
export function sections(text: string): SlackBlock[] {
  const paras = paragraphs(text);
  if (!paras.length) return [];
  // Past the block cap the tail is folded into the last block rather than
  // dropped: a truncated reply is worse than a tall one, and silently losing
  // the end of an answer is worst of all.
  const kept = paras.slice(0, MAX_BLOCKS - 1);
  const tail = paras.slice(MAX_BLOCKS - 1);
  if (tail.length) kept.push(tail.join("\n\n").slice(0, SECTION_MAX));
  return kept.map(section);
}

/**
 * Slack's small muted text. Telegram has none, which is why `formatTurnMeta`
 * lands there as an italic footnote; here the footer gets the block the
 * platform actually has for it.
 */
export const context = (text: string): SlackBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

// --- next-step buttons -------------------------------------------------------

/**
 * `action_id` carries an index, not the label. Slack would allow 2000 chars of
 * `value`, but the index is what makes a button survive a `runtime.reload()`:
 * the label is read back off the message Slack echoes with the click, so no
 * adapter-instance memory is involved.
 */
export const OFFER_PREFIX = "sg:";

const truncate = (label: string): string =>
  label.length > BUTTON_MAX ? `${label.slice(0, BUTTON_MAX - 1)}\u2026` : label;

/**
 * One actions row. Slack wraps buttons on its own and gives each its natural
 * width, so unlike Telegram there is no row packing to budget — a long label
 * beside a short one costs nothing.
 */
export function actions(labels: string[]): SlackBlock | undefined {
  if (!labels.length) return undefined;
  const elements: SlackButton[] = labels.map((label, index) => ({
    type: "button",
    action_id: `${OFFER_PREFIX}${index}`,
    text: { type: "plain_text", text: truncate(label), emoji: true },
  }));
  return { type: "actions", elements };
}

/**
 * The label a next-step `action_id` stands for, read off the clicked message's
 * own blocks — which Slack echoes back in the interaction payload. A button
 * therefore keeps working across a restart or a config reload, where an
 * in-memory offer list would not.
 */
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
