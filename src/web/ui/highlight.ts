// Syntax highlighting. The tokenizer is ui/hljs.ts, ~70 kB only a page showing
// code needs, so it is fetched on the first highlight rather than at boot.
import type { HLJSApi } from "highlight.js";

let hljs: HLJSApi | undefined;
let loading: Promise<HLJSApi | undefined> | undefined;

/** One fetch however many callers race. A chunk that will not load is plain
 *  text, not a pane stuck on "loading": `undefined` reads as "no language". */
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

/** No auto-detection, which guesses wrong on short snippets. Safe after
 *  DOMPurify: hljs escapes its output. */
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

/** Per-line tokenizing loses multi-line constructs (block comments), which
 *  keeps diff-toned lines highlightable independently. */
export function lineEl(text: string, lang: string | null): HTMLElement {
  const el = document.createElement("span");
  // `lang` came from langFor(), which only answers once hljs is here.
  if (hljs && lang && text.length <= 500) el.innerHTML = hljs.highlight(text, { language: lang }).value;
  else el.textContent = text;
  return el;
}
