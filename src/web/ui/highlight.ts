// Syntax highlighting — chat code blocks and Files-view previews. hljs core +
// a curated language set (the full bundle is ~1MB); anything else is plain text.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml }))
  hljs.registerLanguage(name, language);

/**
 * Tokenize fenced blocks in already-rendered markdown. Only fences that named a
 * language we registered are touched — no auto-detection, which guesses wrong
 * on short snippets. Safe after DOMPurify: the input is the node's plain text
 * and hljs escapes its output, so the only new markup is its own token spans.
 */
export function highlightCode(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>("pre code[class]")) {
    const lang = /(?:language|lang)-(\S+)/.exec(el.className)?.[1]?.toLowerCase();
    if (!lang || !hljs.getLanguage(lang)) continue;
    el.innerHTML = hljs.highlight(el.textContent ?? "", { language: lang }).value;
  }
}

/** Extensions whose hljs name isn't the extension itself. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", sh: "bash", zsh: "bash", md: "markdown",
  yml: "yaml", html: "xml", htm: "xml", svg: "xml", patch: "diff",
};

/** The registered language a filename maps to, or null — plain text. */
export function langFor(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : null;
}

/** One highlighted source line, for the Files view's numbered panes. Per-line
 *  tokenizing loses multi-line constructs (block comments) — acceptable for a
 *  viewer, and it keeps diff-toned lines highlightable independently. Same
 *  safety story as above: hljs escapes its output. */
export function lineEl(text: string, lang: string | null): HTMLElement {
  const el = document.createElement("span");
  if (lang && text.length <= 500) el.innerHTML = hljs.highlight(text, { language: lang }).value;
  else el.textContent = text;
  return el;
}
