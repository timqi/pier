// Syntax highlighting — chat code blocks and Files-view previews. Which
// languages, and the tokenizer itself, are ui/hljs.ts: ~70 kB of the bundle
// that only a page showing code needs, so it is fetched on the first highlight
// rather than at boot. Highlighting already waits for a turn's final paint
// (ui/chat.ts), so the two callers that produce colour await this arrival.
import type { HLJSApi } from "highlight.js";

let hljs: HLJSApi | undefined;
let loading: Promise<HLJSApi | undefined> | undefined;

/** The highlighter, on first use — one fetch however many callers race for it.
 *  A chunk that will not load is plain text and a line in the console, not a
 *  pane stuck on "loading": every caller below reads `undefined` as "no
 *  language", which is what an unregistered language already meant. */
function highlighter(): Promise<HLJSApi | undefined> {
  loading ??= import("./hljs.js").then(
    (mod) => (hljs = mod.default),
    (err: unknown) => {
      console.warn("highlighting unavailable — code stays plain text", err);
      return undefined;
    },
  );
  return loading;
}

/**
 * Tokenize fenced blocks in already-rendered markdown. Only fences that named a
 * language we registered are touched — no auto-detection, which guesses wrong
 * on short snippets. Safe after DOMPurify: the input is the node's plain text
 * and hljs escapes its output, so the only new markup is its own token spans.
 */
export async function highlightCode(root: HTMLElement): Promise<void> {
  const hl = await highlighter();
  if (!hl) return;
  for (const el of root.querySelectorAll<HTMLElement>("pre code[class]")) {
    const lang = /(?:language|lang)-(\S+)/.exec(el.className)?.[1]?.toLowerCase();
    if (!lang || !hl.getLanguage(lang)) continue;
    el.innerHTML = hl.highlight(el.textContent ?? "", { language: lang }).value;
  }
}

/** Extensions whose hljs name isn't the extension itself. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", sh: "bash", zsh: "bash", md: "markdown",
  yml: "yaml", html: "xml", htm: "xml", svg: "xml", patch: "diff",
};

/** The registered language a filename maps to, or null — plain text. Also the
 *  gate the highlighter loads behind: a pane asks this before it renders a
 *  line, so awaiting it here is what keeps `lineEl` below synchronous. */
export async function langFor(filename: string): Promise<string | null> {
  const hl = await highlighter();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return hl?.getLanguage(lang) ? lang : null;
}

/** One highlighted source line, for the Files view's numbered panes. Per-line
 *  tokenizing loses multi-line constructs (block comments) — acceptable for a
 *  viewer, and it keeps diff-toned lines highlightable independently. Same
 *  safety story as above: hljs escapes its output. */
export function lineEl(text: string, lang: string | null): HTMLElement {
  const el = document.createElement("span");
  // `lang` came from langFor(), which only answers once hljs is here.
  if (hljs && lang && text.length <= 500) el.innerHTML = hljs.highlight(text, { language: lang }).value;
  else el.textContent = text;
  return el;
}
