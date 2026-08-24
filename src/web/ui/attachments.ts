// Images and file attachments in a chat bubble: the lightbox, the thumbnail
// strip, and agent attachments. The agent links a file it produced as
// `[label](file:///abs/path)`; the link is rewritten to the session's files
// route before sanitizing (DOMPurify drops `file:` URLs, and rightly so), then
// the rendered node is upgraded: images become thumbnails, everything else an
// attachment card with preview + download.

import { $, basename, h } from "./dom.js";

// --- image lightbox + thumbnails ---------------------------------------------------

const imageDialog = $<HTMLDialogElement>("#image-dialog");
const imageFull = $<HTMLImageElement>("#image-full");
const imagePrev = $("#image-prev");
const imageNext = $("#image-next");

/** The clicked thumbnail's gallery in document order. Read at open time rather
 *  than tracked: what is on screen *is* the gallery, so there is no second
 *  list to keep in step with the event stream. */
let gallery: string[] = [];
let shown = 0;

/** Wraps around, so paging never dead-ends on the first or last image. */
function step(delta: number): void {
  if (gallery.length < 2) return;
  shown = (shown + delta + gallery.length) % gallery.length;
  imageFull.src = gallery[shown]!;
}

/** Full-size view of any thumbnail. Paging stays within the `[data-gallery]`
 *  the clicked one sits in — the transcript, or the composer's pending strip —
 *  so the arrows never step out of what you were looking at. */
function showImage(clicked: HTMLImageElement): void {
  const scope = clicked.closest("[data-gallery]");
  gallery = scope
    ? [...scope.querySelectorAll<HTMLImageElement>("img.thumb")].map((i) => i.src)
    : [clicked.src];
  shown = Math.max(0, gallery.indexOf(clicked.src));
  imageFull.src = clicked.src;
  // display, not a `hidden` class: `hidden` and `flex` are the same Tailwind
  // property and which one wins is an ordering accident.
  const arrows = gallery.length < 2 ? "none" : "flex";
  imagePrev.style.display = arrows;
  imageNext.style.display = arrows;
  imageDialog.showModal();
}

// Backdrop and image close; the arrows must not, hence stopPropagation.
imageDialog.onclick = () => imageDialog.close();
const pageOn = (btn: HTMLElement, delta: number): void => {
  btn.onclick = (ev) => {
    ev.stopPropagation();
    step(delta);
  };
};
pageOn(imagePrev, -1);
pageOn(imageNext, 1);
imageDialog.onkeydown = (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  step(ev.key === "ArrowLeft" ? -1 : 1);
};

/** The bubble's thumbnail strip, created on first use: attachments belong in
 *  their own block under the text, not appended to its last line. */
export function imageRow(bubble: HTMLElement): HTMLElement {
  const existing = bubble.querySelector<HTMLElement>(":scope > .thumbs");
  if (existing) return existing;
  const row = h("div", "thumbs");
  bubble.append(row);
  return row;
}

/** Thumbnail tile; click opens the lightbox at this image. The same tile in a
 *  chat row and in the composer's pending strip — one look, one lightbox. */
export function imageThumb(src: string): HTMLImageElement {
  const thumb = document.createElement("img");
  thumb.src = src;
  thumb.loading = "lazy";
  thumb.className = "thumb";
  thumb.onclick = () => showImage(thumb);
  return thumb;
}

// --- agent attachments -------------------------------------------------------------

// No svg: it is served as octet-stream on purpose (inline markup is a script
// vector), so it renders as a card rather than an image.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
// Kinds the preview dialog can show as text; pdf/images open in their own viewer.
const TEXT_EXT = new Set(["txt", "md", "log", "json", "csv", "yaml", "yml"]);
const MAX_PREVIEW_BYTES = 512 * 1024;

const fileDialog = $<HTMLDialogElement>("#file-dialog");
const fileName = $("#file-name");
const fileText = $("#file-text");
const fileDownload = $<HTMLAnchorElement>("#file-download");
$("#file-close").onclick = () => fileDialog.close();

const extOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

const fileUrl = (sessionId: string, path: string, download = false): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}${
    download ? "&download=1" : ""
  }`;

/** `[x](file:///p)` → the session's files route, so the sanitizer keeps it. */
export function rewriteFileLinks(markdown: string, sessionId: string): string {
  return markdown.replace(/\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)/g, (_m, path: string) => {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      /* not percent-encoded — take the path as written */
    }
    return `](${fileUrl(sessionId, decoded)})`;
  });
}

const isFileUrl = (url: string): boolean => /^\/api\/sessions\/[^/]+\/files\?/.test(url);

/** A user-sent file (a core/inbound-file.ts marker), rendered like an agent
 *  attachment (thumb or card). */
export function inboundAttachment(sessionId: string, path: string): HTMLElement {
  const name = basename(path) || "file";
  const url = fileUrl(sessionId, path);
  return IMAGE_EXT.has(extOf(name)) ? thumb(url, name) : card(url, name);
}

/** The `path` query of a files URL — the attachment's name comes from it. */
function pathOf(url: string): string {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("path") ?? "";
}

async function preview(url: string, name: string): Promise<void> {
  fileName.textContent = name;
  fileDownload.href = `${url}&download=1`;
  fileText.textContent = "loading…";
  fileDialog.showModal();
  const res = await fetch(url);
  const body = res.ok ? await res.text() : `failed to load: ${res.status}`;
  fileText.textContent =
    body.length > MAX_PREVIEW_BYTES ? `${body.slice(0, MAX_PREVIEW_BYTES)}\n…` : body;
}

function thumb(url: string, name: string): HTMLElement {
  const img = imageThumb(url);
  img.alt = name;
  return img;
}

/** Name · type on the left, preview + download on the right. */
function card(url: string, name: string): HTMLElement {
  const ext = extOf(name);
  const wrap = h(
    "span",
    // No own margins: the .thumbs strip owns the spacing between attachments.
    "inline-flex max-w-full items-center gap-2.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 no-underline",
  );
  const icon = h(
    "span",
    "flex h-7 w-7 flex-none items-center justify-center rounded-md bg-indigo-50 text-[10px] font-semibold uppercase text-indigo-600",
    ext.slice(0, 4) || "file",
  );
  const label = h("span", "min-w-0 truncate text-[13px] font-medium text-neutral-800", name);
  const actions = h("span", "ml-1 flex flex-none items-center gap-0.5");
  if (TEXT_EXT.has(ext) || ext === "pdf") {
    const eye = h("button", "icon-btn h-6 w-6 text-[13px]", "◉");
    eye.title = "Preview";
    eye.onclick = (ev) => {
      ev.preventDefault();
      if (ext === "pdf") window.open(url, "_blank", "noopener");
      else void preview(url, name);
    };
    actions.append(eye);
  }
  const download = document.createElement("a");
  download.className = "icon-btn h-6 w-6 text-[13px] no-underline";
  download.href = `${url}&download=1`;
  download.download = name;
  download.title = "Download";
  download.textContent = "↓";
  actions.append(download);
  wrap.append(icon, label, actions);
  return wrap;
}

/**
 * Attachments get a row of their own under the prose: a block containing
 * nothing but attachments becomes the strip, and attachments written into a
 * sentence are lifted into a strip right after it. Either way a set of them
 * packs across the row and wraps, rather than trailing the text one per line.
 */
function groupAttachments(placed: HTMLElement[]): void {
  const blocks = new Set<HTMLElement>();
  for (const node of placed) if (node.parentElement) blocks.add(node.parentElement);
  for (const block of blocks) {
    const mine = [...block.children].filter((c) => placed.includes(c as HTMLElement));
    const bare = [...block.childNodes].every((n) =>
      n.nodeType === Node.TEXT_NODE ? !n.textContent?.trim() : mine.includes(n as Element),
    );
    if (bare) {
      block.classList.add("thumbs");
      continue;
    }
    const strip = h("div", "thumbs");
    strip.append(...mine);
    block.after(strip);
  }
}

/**
 * Upgrade every attachment node of a rendered markdown bubble in place. Called
 * after sanitizing, so only URLs the rewrite produced are touched.
 */
export function renderAttachments(root: HTMLElement): void {
  const placed: HTMLElement[] = [];
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!isFileUrl(src)) continue;
    const node = thumb(src, basename(pathOf(src)));
    img.replaceWith(node);
    placed.push(node);
  }
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (!isFileUrl(href)) continue;
    const name = basename(pathOf(href)) || a.textContent?.trim() || "file";
    const node = IMAGE_EXT.has(extOf(name)) ? thumb(href, name) : card(href, name);
    a.replaceWith(node);
    placed.push(node);
  }
  if (placed.length) groupAttachments(placed);
}
