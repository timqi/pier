// Chat markdown read without its marks, for a surface that shows no markup: the
// workbench's excerpts and a notification's body. Shared by the server and the
// browser bundle, so it imports nothing but `marked`.

import { Marked, type Token, type TokenizerExtension, type Tokens } from "marked";

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** CommonMark will not open or close `**` on punctuation beside a letter, and
 *  CJK prose puts `：`, `“` or `。` there constantly (`结论：**重要。**后面`).
 *  A run touching CJK is strong regardless; code spans and escapes inside it
 *  stay atomic, and every other run is left to the standard rule. */
export const cjkStrong: TokenizerExtension = {
  name: "cjkStrong",
  level: "inline",
  start: (src) => {
    const at = src.indexOf("**");
    return at < 0 ? undefined : at;
  },
  tokenizer(src, tokens) {
    const m = /^\*\*(?![\s*])((?:`[^`\n]*`|\\[\s\S]|[^\\`*]|\*(?!\*))+?)\*\*(?!\*)/.exec(src);
    const inner = m?.[1];
    if (!m || !inner || /\s$/.test(inner)) return undefined;
    const edges = [tokens.at(-1)?.raw.at(-1), inner[0], inner.at(-1), src[m[0].length]];
    if (!edges.some((c) => c && CJK.test(c))) return undefined;
    return { type: "strong", raw: m[0], text: inner, tokens: this.lexer.inlineTokens(inner) };
  },
};

/** Chat text is markdown on every surface, IM included: a `<slug>` in it is
 *  text, never a tag. */
export const textTokens = { tokenizer: { html: () => undefined, tag: () => undefined }, extensions: [cjkStrong] };
const textLexer = new Marked(textTokens);

/** Chat markdown with the marks off, one line per block and a table row's
 *  cells joined by ` · `: what a two-line excerpt has room for. */
export function plainText(markdown: string): string {
  return blocksText(textLexer.lexer(markdown));
}

const blocksText = (tokens: Token[]): string => tokens.map(blockText).filter(Boolean).join("\n");

/** Marked's union carries a catch-all member, so a `type` check narrows nothing. */
const loose = (t: Token): { raw: string; text?: string; tokens?: Token[] } => t;

function blockText(t: Token): string {
  switch (t.type) {
    case "space":
    case "hr":
      return "";
    case "code":
      return loose(t).text ?? "";
    case "list":
      return (t as Tokens.List).items.map((item) => blocksText(item.tokens)).join("\n");
    case "table": {
      const { header, rows } = t as Tokens.Table;
      return [header, ...rows].map((row) => row.map((cell) => inlineText(cell.tokens)).join(" \u00b7 ")).join("\n");
    }
    case "blockquote":
      return blocksText(loose(t).tokens ?? []);
    default: {
      const { tokens, text, raw } = loose(t);
      return tokens ? inlineText(tokens) : (text ?? raw);
    }
  }
}

const inlineText = (tokens: Token[]): string =>
  tokens.map((t) => {
    const { tokens: inner, text, raw } = loose(t);
    if (t.type === "br") return "\n";
    return t.type !== "image" && inner?.length ? inlineText(inner) : (text ?? raw);
  }).join("");
