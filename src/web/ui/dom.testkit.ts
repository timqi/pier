// The one DOM double web/ui tests run against under plain Node: the members the
// UI modules touch, with the browser's semantics. No layout (geometry reads as
// zero, no rects), no CSS parsing, and innerHTML parses well-formed markup only.

import { vi } from "vitest";
import html from "./index.html?raw";

type Handler = ((event?: unknown) => unknown) | null;
type Child = FakeElement | FakeText;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const FORM_CONTROLS = new Set(["button", "input", "select", "textarea", "optgroup", "option", "fieldset"]);
const FOCUSABLE = new Set(["button", "input", "select", "textarea", "summary"]);

/** Focus per document, and the document each root element belongs to. */
const focused = new WeakMap<FakeDocument, FakeElement>();
const documents = new WeakMap<FakeElement, FakeDocument>();

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = (s: string): string =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) =>
    name[0] === "#" ? String.fromCodePoint(Number(name[1] === "x" || name[1] === "X" ? `0${name.slice(1)}` : name.slice(1))) : ENTITIES[name] ?? whole);

function* ancestors(el: FakeElement): Generator<FakeElement> {
  for (let n: FakeElement | null = el; n; n = n.parentNode) yield n;
}

export class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  set textContent(text: string) { this.data = text; }
  remove(): void { this.parentNode?.removeChild(this); }
}

class FakeTokenList {
  constructor(private readonly el: FakeElement) {}
  private get tokens(): string[] { return (this.el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean); }
  private write(tokens: string[]): void {
    if (!this.el.hasAttribute("class") && !tokens.length) return;
    this.el.setAttribute("class", [...new Set(tokens)].join(" "));
  }
  contains(token: string): boolean { return this.tokens.includes(token); }
  add(...tokens: string[]): void { this.write([...this.tokens, ...tokens]); }
  remove(...tokens: string[]): void { this.write(this.tokens.filter((t) => !tokens.includes(t))); }
  toggle(token: string, force?: boolean): boolean {
    const on = force ?? !this.contains(token);
    if (on) this.add(token);
    else this.remove(token);
    return on;
  }
  replace(from: string, to: string): boolean {
    if (!this.contains(from)) return false;
    this.write(this.tokens.map((t) => (t === from ? to : t)));
    return true;
  }
}

/** CSS properties as the strings they were given; custom properties by name. */
class FakeStyle {
  [property: string]: unknown;
  setProperty(name: string, value: string): void { this[FakeStyle.key(name)] = value; }
  getPropertyValue(name: string): string { return (this[FakeStyle.key(name)] as string | undefined) ?? ""; }
  private static key(name: string): string {
    return name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  }
}

/** Compound selectors in a comma list: tag, `#id`, `.class`, `[attr]`, `[attr=v]`,
 *  `:disabled`. Combinators throw rather than match wrongly. */
function matcher(selector: string): (el: FakeElement) => boolean {
  const alternatives = (selector.match(/(?:[^,"']|"[^"]*"|'[^']*')+/g) ?? []).map((raw) => {
    const part = raw.trim();
    const m = /^(\*|[a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]"']*))?\]|:disabled)*)$/i.exec(part);
    if (!m) throw new Error(`fake DOM: unsupported selector ${JSON.stringify(selector)}`);
    const tests: ((el: FakeElement) => boolean)[] = [];
    const tag = m[1]?.toLowerCase();
    if (tag && tag !== "*") tests.push((el) => el.localName === tag);
    for (const [token] of m[2]!.matchAll(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:\w+/g)) {
      if (token[0] === "#") tests.push((el) => el.id === token.slice(1));
      else if (token[0] === ".") tests.push((el) => el.classList.contains(token.slice(1)));
      else if (token === ":disabled") tests.push((el) => FORM_CONTROLS.has(el.localName) && el.disabled);
      else {
        const [, name, quoted, single, bare] = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(.*)))?\]$/.exec(token)!;
        const value = quoted ?? single ?? bare;
        tests.push((el) => (value === undefined ? el.hasAttribute(name!) : el.getAttribute(name!) === value));
      }
    }
    return (el: FakeElement) => tests.every((test) => test(el));
  });
  return (el) => alternatives.some((matches) => matches(el));
}

/** Well-formed markup into nodes: elements, attributes, text, entities; comments dropped. */
function parse(html: string): Child[] {
  const top = new FakeElement("template");
  let at = top;
  let consumed = 0;
  const tokens = /<!--[\s\S]*?-->|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s/>=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|([^<]+|<(?![a-z/!]))/gi;
  for (const [whole, close, open, attrs, selfClosing, text] of html.matchAll(tokens)) {
    consumed += whole.length;
    if (text !== undefined) at.append(decode(text));
    else if (open) {
      const el = new FakeElement(open.toLowerCase());
      for (const [, name, quoted, single, bare] of attrs!.matchAll(/([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g))
        el.setAttribute(name!, decode(quoted ?? single ?? bare ?? ""));
      at.append(el);
      if (!VOID.has(el.localName) && !selfClosing) at = el;
    } else if (close) {
      let node: FakeElement | null = at;
      while (node && node !== top && node.localName !== close.toLowerCase()) node = node.parentElement;
      if (node && node !== top) at = node.parentElement!;
    }
  }
  if (consumed !== html.length) throw new Error("fake DOM: innerHTML takes well-formed markup only");
  return [...top.childNodes];
}

export class FakeElement extends EventTarget {
  readonly localName: string;
  readonly namespaceURI: string;
  parentNode: FakeElement | null = null;
  readonly classList = new FakeTokenList(this);
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string | undefined>;
  /** An option's selectedness; select.value reads and writes it. */
  selected = false;
  scrollTop = 0;
  readonly scrollHeight = 0;
  readonly offsetHeight = 0;
  readonly offsetWidth = 0;
  onclick: Handler = null;
  onchange: Handler = null;
  oninput: Handler = null;
  onkeydown: Handler = null;
  onpaste: Handler = null;
  onsubmit: Handler = null;
  onscroll: Handler = null;
  ontoggle: Handler = null;
  declare id: string;
  declare title: string;
  declare name: string;
  declare placeholder: string;
  declare disabled: boolean;
  declare hidden: boolean;
  declare inert: boolean;
  declare open: boolean;
  #nodes: Child[] = [];
  #attrs = new Map<string, string>();
  #value = "";
  #checked = false;

  constructor(tag: string, namespaceURI = HTML_NS) {
    super();
    this.localName = tag;
    this.namespaceURI = namespaceURI;
    const attr = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const keys = (): string[] =>
      [...this.#attrs.keys()].filter((n) => n.startsWith("data-")).map((n) => n.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_, key) => (typeof key === "string" ? this.getAttribute(attr(key)) ?? undefined : undefined),
      set: (_, key, value) => { this.setAttribute(attr(String(key)), String(value)); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(attr(String(key))); return true; },
      has: (_, key) => typeof key === "string" && this.hasAttribute(attr(key)),
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (_, key) =>
        typeof key === "string" && this.hasAttribute(attr(key))
          ? { value: this.getAttribute(attr(key)), enumerable: true, configurable: true, writable: true }
          : undefined,
    });
  }

  // --- attributes -----------------------------------------------------------------
  setAttribute(name: string, value: unknown): void { this.#attrs.set(this.namespaceURI === HTML_NS ? name.toLowerCase() : name, String(value)); }
  getAttribute(name: string): string | null { return this.#attrs.get(this.namespaceURI === HTML_NS ? name.toLowerCase() : name) ?? null; }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  removeAttribute(name: string): void { this.#attrs.delete(this.namespaceURI === HTML_NS ? name.toLowerCase() : name); }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on && !this.hasAttribute(name)) this.setAttribute(name, "");
    if (!on) this.removeAttribute(name);
    return on;
  }
  getAttributeNames(): string[] { return [...this.#attrs.keys()]; }

  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get type(): string {
    return this.getAttribute("type")?.toLowerCase() ?? (this.localName === "input" ? "text" : this.localName === "button" ? "submit" : "");
  }
  set type(value: string) { this.setAttribute("type", value); }
  get tabIndex(): number {
    const set = Number.parseInt(this.getAttribute("tabindex") ?? "", 10);
    return Number.isNaN(set) ? (this.#focusableByDefault() ? 0 : -1) : set;
  }
  set tabIndex(value: number) { this.setAttribute("tabindex", String(value)); }

  // --- form values ----------------------------------------------------------------
  get value(): string {
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    if (this.localName === "select") return this.options.find((o) => o.selected)?.value ?? "";
    return this.#value;
  }
  set value(value: string) {
    if (this.localName === "option") this.setAttribute("value", value);
    else if (this.localName === "select") {
      let hit = false;
      for (const o of this.options) hit = (o.selected = !hit && o.value === String(value)) || hit;
    } else this.#value = String(value);
  }
  /** Checking a radio unchecks the others of its name in the same tree. */
  get checked(): boolean { return this.#checked; }
  set checked(on: boolean) {
    this.#checked = Boolean(on);
    if (!on || this.localName !== "input" || this.type !== "radio" || !this.name) return;
    for (const other of this.#top().querySelectorAll("input"))
      if (other !== this && other.type === "radio" && other.name === this.name) other.#checked = false;
  }
  get options(): FakeElement[] { return this.localName === "select" ? this.querySelectorAll("option") : []; }
  /** A single select keeps exactly one option picked once it has any: the last
   *  one marked, or the first when none is. */
  #resetSelect(): void {
    const select = this.closest("select");
    if (!select) return;
    const options = select.options;
    const picked = options.filter((o) => o.selected);
    for (const o of picked.slice(0, -1)) o.selected = false;
    if (!picked.length && options[0]) options[0].selected = true;
  }

  // --- tree -----------------------------------------------------------------------
  get childNodes(): readonly Child[] { return this.#nodes; }
  get children(): FakeElement[] { return this.#nodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get childElementCount(): number { return this.children.length; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get parentElement(): FakeElement | null { return this.parentNode; }
  get previousElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    const i = siblings.indexOf(this);
    return i < 0 ? null : siblings[i + 1] ?? null;
  }
  #top(): FakeElement { return [...ancestors(this)].at(-1)!; }
  /** The document this element is in, if it is in one. */
  #document(): FakeDocument | undefined { return documents.get(this.#top()); }
  get isConnected(): boolean { return this.#document() !== undefined; }
  contains(other: unknown): boolean {
    for (let n = other instanceof FakeElement || other instanceof FakeText ? other : null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  /** Inserts before `ref` (null: at the end), each node leaving its old parent first. */
  #insert(nodes: (Child | string)[], ref: Child | null): void {
    // Like the browser, anything that is not a node goes in as its string.
    const list = nodes.map((n) => (n instanceof FakeElement || n instanceof FakeText ? n : new FakeText(String(n))));
    for (const n of list) {
      if (n instanceof FakeElement && n.contains(this)) throw new Error("fake DOM: HierarchyRequestError");
      n.parentNode?.removeChild(n);
      n.parentNode = this;
    }
    const at = ref ? this.#nodes.indexOf(ref) : -1;
    this.#nodes.splice(at < 0 ? this.#nodes.length : at, 0, ...list);
    this.#resetSelect();
  }
  /** The first sibling after this one that is not itself being moved. */
  #nextOutside(nodes: (Child | string)[]): Child | null {
    const siblings = this.parentNode!.#nodes;
    return siblings.slice(siblings.indexOf(this) + 1).find((n) => !nodes.includes(n)) ?? null;
  }
  append(...nodes: (Child | string)[]): void { this.#insert(nodes, null); }
  prepend(...nodes: (Child | string)[]): void { this.#insert(nodes, this.#nodes[0] ?? null); }
  appendChild<T extends Child>(node: T): T { this.#insert([node], null); return node; }
  removeChild<T extends Child>(node: T): T {
    const i = this.#nodes.indexOf(node);
    if (i < 0) throw new Error("fake DOM: NotFoundError");
    this.#nodes.splice(i, 1);
    node.parentNode = null;
    this.#resetSelect();
    return node;
  }
  replaceChildren(...nodes: (Child | string)[]): void {
    for (const n of this.#nodes) n.parentNode = null;
    this.#nodes = [];
    this.#insert(nodes, null);
  }
  before(...nodes: (Child | string)[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    const siblings = parent.#nodes;
    parent.#insert(nodes, siblings.slice(siblings.indexOf(this)).find((n) => !nodes.includes(n)) ?? null);
  }
  after(...nodes: (Child | string)[]): void {
    if (this.parentNode) this.parentNode.#insert(nodes, this.#nextOutside(nodes));
  }
  replaceWith(...nodes: (Child | string)[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this.#nextOutside(nodes);
    parent.removeChild(this);
    parent.#insert(nodes, next);
  }
  remove(): void { this.parentNode?.removeChild(this); }

  // --- text and markup ------------------------------------------------------------
  get textContent(): string { return this.#nodes.map((n) => n.textContent).join(""); }
  set textContent(text: string | null) { this.replaceChildren(...(text ? [text] : [])); }
  get innerHTML(): string {
    return this.#nodes.map((n) => (n instanceof FakeText ? escapeText(n.data) : n.outerHTML)).join("");
  }
  set innerHTML(html: string) { this.replaceChildren(...parse(html)); }
  get outerHTML(): string {
    const attrs = [...this.#attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    return VOID.has(this.localName) ? `<${this.localName}${attrs}>` : `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }

  // --- selectors ------------------------------------------------------------------
  matches(selector: string): boolean { return matcher(selector)(this); }
  closest(selector: string): FakeElement | null {
    return [...ancestors(this)].find(matcher(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const test = matcher(selector);
    const found: FakeElement[] = [];
    const visit = (el: FakeElement): void => {
      for (const child of el.children) {
        if (test(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }

  // --- focus, dialogs, geometry ---------------------------------------------------
  #focusableByDefault(): boolean {
    return FOCUSABLE.has(this.localName) || (this.localName === "a" && this.hasAttribute("href"));
  }
  /** Real focus() does nothing off-document, inside an inert subtree, or on an
   *  element that is neither a control nor given a tabindex. */
  focus(): void {
    if (!this.isConnected || (FORM_CONTROLS.has(this.localName) && this.disabled)) return;
    if (!this.#focusableByDefault() && !this.hasAttribute("tabindex")) return;
    if ([...ancestors(this)].some((n) => n.inert)) return;
    focused.set(this.#document()!, this);
  }
  showModal(): void { this.open = true; }
  /** Like the browser, the close event arrives on a later task, not inside close(). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.dispatchEvent(new Event("close")));
  }
  getClientRects(): object[] { return []; }
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number } {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  }
}

// Reflected attributes: the property is the attribute, read and written.
for (const name of ["id", "title", "name", "placeholder"])
  Object.defineProperty(FakeElement.prototype, name, {
    get(this: FakeElement) { return this.getAttribute(name) ?? ""; },
    set(this: FakeElement, value: string) { this.setAttribute(name, value); },
  });
for (const name of ["disabled", "hidden", "inert", "open"])
  Object.defineProperty(FakeElement.prototype, name, {
    get(this: FakeElement) { return this.hasAttribute(name); },
    set(this: FakeElement, value: boolean) { this.toggleAttribute(name, Boolean(value)); },
  });

/** `new Option(text, value)`. */
export class FakeOption extends FakeElement {
  constructor(text = "", value?: string) {
    super("option");
    if (text) this.append(text);
    if (value !== undefined) this.value = value;
  }
}

export class FakeDocument extends EventTarget {
  readonly documentElement = new FakeElement("html");
  readonly body = new FakeElement("body");
  constructor() {
    super();
    documents.set(this.documentElement, this);
    this.documentElement.append(this.body);
  }
  get activeElement(): FakeElement {
    const el = focused.get(this);
    return el?.isConnected ? el : this.body;
  }
  createElement(tag: string): FakeElement { return new FakeElement(tag.toLowerCase()); }
  createElementNS(namespaceURI: string, tag: string): FakeElement {
    return new FakeElement(namespaceURI === HTML_NS ? tag.toLowerCase() : tag, namespaceURI);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return [this.documentElement, ...this.documentElement.querySelectorAll("*")].filter((el) => el.matches(selector));
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

/** A fresh document as the global `document`, with `Option` beside it; the
 *  test's `vi.unstubAllGlobals()` takes both away. */
export function installDom(): FakeDocument {
  const doc = new FakeDocument();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Option", FakeOption);
  return doc;
}

/** installDom() with index.html's body in it: the markup the workbench's
 *  modules query on import. */
export function installPage(): FakeDocument {
  const doc = installDom();
  doc.body.innerHTML = html.slice(html.indexOf(">", html.indexOf("<body")) + 1, html.indexOf("</body>"));
  return doc;
}

/** What a UI module built for HTMLElement, seen as the fake it is. */
export function fake(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) throw new TypeError("not a fake DOM element");
  return node;
}

/** Every attribute by name, as the element holds it now. */
export const attributes = (el: FakeElement): Record<string, string> =>
  Object.fromEntries(el.getAttributeNames().map((name) => [name, el.getAttribute(name)!]));

/** The element and everything under it, in document order. */
export const walk = (root: FakeElement): FakeElement[] => [root, ...root.querySelectorAll("*")];

/** The button whose whole text is `text`, or matches it when a RegExp. */
export const button = (root: FakeElement, text: string | RegExp): FakeElement | undefined =>
  walk(root).find((el) => el.localName === "button" && (typeof text === "string" ? el.textContent === text : text.test(el.textContent)));

/** The element whose `aria-label` is `label`. */
export const labelled = (root: FakeElement, label: string): FakeElement | undefined =>
  walk(root).find((el) => el.getAttribute("aria-label") === label);
