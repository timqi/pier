// Images and file attachments in a chat bubble: the lightbox, the thumbnail
// strip, and agent attachments. The agent links a file it produced as
// `[label](file:///abs/path)`; the link is rewritten to the session's files
// route before sanitizing (DOMPurify drops `file:` URLs, and rightly so), then
// the rendered node is upgraded: images become thumbnails, everything else an
// attachment card with preview + download.

import { Download, Eye } from "lucide";
import { icon } from "./icons.js";
import { replaceOutsideCode } from "../../core/inbound-file.js";
import { failure } from "./api.js";
import { codePane, fileRows } from "./code.js";
import { $, basename, h } from "./dom.js";
import { langFor } from "./highlight.js";

// --- image lightbox + thumbnails ---------------------------------------------------

const imageDialog = $<HTMLDialogElement>("#image-dialog");
const imageStage = $("#image-stage");
const imageFull = $<HTMLImageElement>("#image-full");
const imagePrev = $("#image-prev");
const imageNext = $("#image-next");
const imageClose = $("#image-close");

/** The clicked thumbnail's gallery in document order. Read at open time rather
 *  than tracked: what is on screen *is* the gallery, so there is no second
 *  list to keep in step with the event stream. */
let gallery: string[] = [];
let shown = 0;

/** Wraps around, so paging never dead-ends on the first or last image. */
function step(delta: number): void {
  if (gallery.length < 2) return;
  shown = (shown + delta + gallery.length) % gallery.length;
  zoom(false);
  imageFull.src = gallery[shown]!;
}

// --- zoom -------------------------------------------------------------------------

const ZOOM = 2.5;
/** The flag style.css keys the zoomed layout off is also the state — there is
 *  no second copy of it to fall out of step. */
const zoomed = (): boolean => imageStage.dataset.zoom !== undefined;

/** Grow the image to a fixed multiple of its fitted size about the tapped
 *  point; the stage becomes the scroll box, so where you are in the image is
 *  its scroll offset and nothing else has to remember it. `at` is a viewport
 *  point — the tap — which stays where it was under the growth.
 *  Pinching is not an option to add here: the workbench turns page zoom off
 *  (index.html, style.css, main.ts), so a tap is the whole gesture. */
function zoom(on: boolean, at?: { x: number; y: number }): void {
  if (!on) {
    delete imageStage.dataset.zoom;
    imageFull.style.cssText = "";
    return;
  }
  // Both boxes read while the image is still fitted, the fractions with them.
  const box = imageFull.getBoundingClientRect();
  const stage = imageStage.getBoundingClientRect();
  const fx = at ? (at.x - box.left) / box.width : 0.5;
  const fy = at ? (at.y - box.top) / box.height : 0.5;
  const width = box.width * ZOOM;
  const height = box.height * ZOOM;
  imageStage.dataset.zoom = "";
  imageFull.style.width = `${String(width)}px`;
  imageFull.style.height = `${String(height)}px`;
  imageStage.scrollLeft = fx * width - stage.width / 2;
  imageStage.scrollTop = fy * height - stage.height / 2;
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

// A tap on the image magnifies it and a second one fits it again — what the
// zoom-in cursor has been promising; a tap on the scrim around it closes, as
// does the ✕ (a phone has no Esc). This was a double-tap-to-zoom with a 260ms
// window, which is shorter than two deliberate taps: on the surface the
// gesture is for, "zoom" was read as "close" nearly every time.
// Dragging a zoomed image. The stage is a scroll box, so a *touch* could
// already pan it — a mouse could not: an overflow box has no drag-to-scroll,
// and the scrollbars are the one handle a lightbox has no room to show. Pointer
// events, so finger and mouse take one path (style.css hands us the touch as
// well, with `touch-action: none` while zoomed); the capture keeps the drag
// alive when the pointer leaves the image, or the window.
const SLOP = 4; // a click from a shaky hand is still a click
let from: { x: number; y: number; left: number; top: number } | undefined;
let panned = false;
imageStage.onpointerdown = (ev) => {
  panned = false; // before the guard: a stale pan would eat the next click
  if (!zoomed() || ev.button !== 0) return;
  from = { x: ev.clientX, y: ev.clientY, left: imageStage.scrollLeft, top: imageStage.scrollTop };
  imageStage.setPointerCapture(ev.pointerId);
};
imageStage.onpointermove = (ev) => {
  if (!from) return;
  const dx = ev.clientX - from.x;
  const dy = ev.clientY - from.y;
  if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) panned = true;
  imageStage.scrollLeft = from.left - dx;
  imageStage.scrollTop = from.top - dy;
};
const endPan = (): void => {
  from = undefined;
};
imageStage.onpointerup = endPan;
imageStage.onpointercancel = endPan;

imageStage.onclick = (ev) => {
  // A drag is a pan, not the click that would fit the image again.
  if (panned) return;
  if (ev.target === imageFull) zoom(!zoomed(), { x: ev.clientX, y: ev.clientY });
  else imageDialog.close();
};
imageClose.onclick = () => imageDialog.close();
// However it closed — the ✕, Esc, the scrim — the next image opens fitted.
imageDialog.onclose = () => zoom(false);
// The arrows sit outside #image-stage, so paging never reaches the tap handler.
imagePrev.onclick = () => step(-1);
imageNext.onclick = () => step(1);
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

// No svg: it is served as a download on purpose (inline markup is a script
// vector), so it renders as a card rather than an image — the preview below
// shows its markup, which is safe, instead of rendering it.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const MAX_PREVIEW_BYTES = 512 * 1024;

const fileDialog = $<HTMLDialogElement>("#file-dialog");
const fileName = $("#file-name");
const fileBody = $("#file-text");
const fileDownload = $<HTMLAnchorElement>("#file-download");
$("#file-close").onclick = () => fileDialog.close();

const extOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

const fileUrl = (sessionId: string, path: string, download = false): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}${
    download ? "&download=1" : ""
  }`;

/** `[x](file:///p)` → the session's files route, so the sanitizer keeps it.
 *  Not inside code: an example link is the code the reader asked to see. */
export function rewriteFileLinks(markdown: string, sessionId: string): string {
  return replaceOutsideCode(markdown, /\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)/g, (match) => {
    let decoded = match[1]!;
    try {
      decoded = decodeURIComponent(decoded);
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

const previewNote = (msg: string, tone = "text-neutral-500"): HTMLElement =>
  h("div", `px-3 py-2 text-[12.5px] ${tone}`, msg);

/** Only the newest open may write the dialog: a slow fetch for the file just
 *  closed must not land on the one now shown. */
let previewSeq = 0;

/**
 * Any text file, as itself: the Files view's numbered, highlighted pane
 * (ui/code.ts), so a `.diff`, a `.ts` or a `.md` reads here the way it reads
 * there. What counts as text is not an extension list but the type the server
 * served the bytes as — it sniffs (web/fs.ts), and bytes it won't vouch for
 * are a download, not a pane full of mojibake. An SVG comes back as itself and
 * is shown as its markup: a card on purpose, never rendered.
 */
async function preview(url: string, name: string): Promise<void> {
  const seq = ++previewSeq;
  fileName.textContent = name;
  fileDownload.href = `${url}&download=1`;
  fileBody.replaceChildren(previewNote("loading…"));
  fileDialog.showModal();
  const show = (node: HTMLElement): void => {
    if (seq === previewSeq) fileBody.replaceChildren(node);
  };
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return show(previewNote(`failed to load: ${String(err)}`, "text-red-600"));
  }
  if (!res.ok) return show(previewNote(await failure(res, "failed to load"), "text-red-600"));
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/") && !type.startsWith("image/svg+xml")) {
    return show(previewNote("Binary file — use Download."));
  }
  const body = await res.text();
  const text = body.length > MAX_PREVIEW_BYTES ? `${body.slice(0, MAX_PREVIEW_BYTES)}\n…` : body;
  const lang = await langFor(name); // the first preview waits for hljs
  show(codePane(fileRows(text), lang));
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
  const fileType = h(
    "span",
    "flex h-7 w-7 flex-none items-center justify-center rounded-md bg-indigo-50 text-[10px] font-semibold uppercase text-indigo-600",
    ext.slice(0, 4) || "file",
  );
  const label = h("span", "min-w-0 truncate text-[13px] font-medium text-neutral-800", name);
  const actions = h("span", "ml-1 flex flex-none items-center gap-0.5");
  // Every card offers a look: what it can show is decided by the bytes, not
  // by the name, so a file with no extension or an unusual one is not a
  // download-only dead end.
  const eye = h("button", "icon-btn h-6 w-6 text-[13px]", icon(Eye));
  eye.setAttribute("aria-label", "Preview");
  eye.title = "Preview";
  eye.onclick = (ev) => {
    ev.preventDefault();
    if (ext === "pdf") window.open(url, "_blank", "noopener");
    else void preview(url, name);
  };
  actions.append(eye);
  const download = document.createElement("a");
  download.className = "icon-btn h-6 w-6 text-[13px] no-underline";
  download.href = `${url}&download=1`;
  download.download = name;
  download.title = "Download";
  download.append(icon(Download));
  download.setAttribute("aria-label", "Download");
  actions.append(download);
  wrap.append(fileType, label, actions);
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
