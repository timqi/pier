// Syntax highlighting for chat code blocks. hljs core + a curated language set
// (the full bundle is ~1MB); anything else renders as plain text.
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
