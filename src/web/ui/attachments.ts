// Opening a file from a chat bubble: the lightbox, the thumbnail strip, agent
// attachments, and a code span that names one — the last two open the Files
// dialog (explorer.ts). A `file://` link is rewritten to the files route before
// sanitizing (DOMPurify drops `file:` URLs), then upgraded to a thumbnail or card.

import { Download, Eye } from "lucide";
import { icon } from "./icons.js";
import { replaceOutsideCode } from "../../core/inbound-file.js";
import { postJson } from "./api.js";
import { listing } from "./dir-picker.js";
import { $, basename, h } from "./dom.js";

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

/** The stage becomes the scroll box, so the position is its scroll offset.
 *  Pinching is not available: the workbench turns page zoom off. */
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

// Single tap zooms (a double-tap window is shorter than two deliberate taps);
// the ✕ exists because a phone has no Esc. Dragging: a mouse has no
// drag-to-scroll on an overflow box, so pointer events take finger and mouse
// down one path; the capture keeps the drag alive past the image's edge.
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
// vector), so it renders as a card rather than a thumbnail.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

const extOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

const fileUrl = (sessionId: string, path: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`;

/** Opens a path in the Files dialog. A chunk that will not load is an
 *  unhandled rejection, which report.ts puts in the chat (§5). */
const openInFiles = (sessionId: string, cwd: string | null, path: string, line?: number): void =>
  void import("./explorer.js").then((m) => m.openPath({ id: sessionId, cwd: cwd ?? "" }, path, line));

/** `[x](file:///p)` and `![x](/tmp/p.png)` → the session's files route: the
 *  sanitizer drops `file:`, and a bare path would ask this server for its own
 *  `/tmp`. A bare one only under a filesystem root, so `/boards/x` stays a route.
 *  Not inside code: an example link is the code the reader asked to see. */
export function rewriteFileLinks(markdown: string, sessionId: string): string {
  return replaceOutsideCode(markdown, /\]\(\s*<?(file:\/\/)?(\/[^)>\s]*)>?\s*\)/g, (match) => {
    if (!match[1] && !FS_ROOT.test(match[2]!)) return match[0];
    let decoded = match[2]!;
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

/** Extensions that are a file even without a directory in front of them.
 *  Everything else needs a `/`, so `res.text` stays a method call. */
const REF_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "md", "css", "html",
  "py", "rs", "go", "rb", "java", "c", "h", "cpp", "hpp", "sh", "sql",
  "yml", "yaml", "toml", "ini", "conf", "txt", "lock",
]);

/** Under one of these a path is a path with no extension to prove it — `~/.pier`
 *  and `/home/qiqi/code` are places on disk, while `/api/fs/ls` in prose is a
 *  route. Directories included: the dialog browses one. */
const FS_ROOT = /^(?:~|\/(?:home|Users|root|tmp|var|opt|etc|srv|mnt|media|data|usr))(?:\/|$)/;

/** `src/web/ui/chat.ts:481`, `chat.ts:481:12`, `/tmp/run.log`, `~/.pier/boards` —
 *  path, and the line if one was named. A column is parsed only to be dropped;
 *  off a filesystem root an extension is required, since `src/web/ui` is as
 *  likely a directory as a file. */
export function parseFileRef(raw: string): { path: string; line?: number } | null {
  const m = /^([^\s`"'()[\]{}<>]+?)(?::(\d+))?(?::\d+)?$/.exec(raw);
  if (!m || raw.includes("://")) return null;
  const path = m[1]!;
  const ext = path.includes(".") ? extOf(path) : "";
  if (!FS_ROOT.test(path) && (!ext || (!REF_EXT.has(ext) && !path.includes("/")))) return null;
  return { path, line: m[2] === undefined ? undefined : Number(m[2]) };
}

/** The home directory is the server's, learned once from the listing route. */
let homePath: Promise<string | null> | undefined;

/** Where a reference is, absolute (the files routes take nothing else) with
 *  the cwd it was read under: `~` and `/` name one place, a relative path one
 *  per cwd, the first that exists winning — all asked in the one batch. */
async function locateRef(path: string, cwds: readonly string[]): Promise<{ path: string; cwd: string | null } | null> {
  let candidates: { path: string; cwd: string | null }[];
  if (path.startsWith("~")) {
    homePath ??= listing().then((l) => l?.path ?? null);
    const home = await homePath;
    candidates = home === null ? [] : [{ path: `${home}${path.slice(1)}`, cwd: cwds[0] ?? null }];
  } else if (path.startsWith("/")) candidates = [{ path, cwd: cwds[0] ?? null }];
  else candidates = cwds.map((cwd) => ({ path: `${cwd}/${path}`, cwd }));
  const found = await Promise.all(candidates.map((c) => exists(c.path)));
  return candidates[found.indexOf(true)] ?? null;
}

/** Paths asked about since the last check, each with everyone waiting on it:
 *  a replayed transcript draws hundreds of references, and they share one request. */
let asked: Map<string, ((found: boolean) => void)[]> | null = null;

function exists(path: string): Promise<boolean> {
  return new Promise((done) => {
    if (!asked) {
      asked = new Map();
      setTimeout(() => void checkAsked(), 0);
    }
    asked.set(path, [...(asked.get(path) ?? []), done]);
  });
}

/** The most paths `/api/fs/exists` takes in one request (web/fs.ts). */
const EXISTS_MAX = 1000;

/** A failed slice leaves the references in it plain code, and says so once (§5). */
async function checkAsked(): Promise<void> {
  const batch = asked!;
  asked = null;
  const paths = [...batch.keys()];
  const slices = Array.from({ length: Math.ceil(paths.length / EXISTS_MAX) }, (_, i) => paths.slice(i * EXISTS_MAX, (i + 1) * EXISTS_MAX));
  const answers = await Promise.all(slices.map((slice) =>
    postJson<{ exists: boolean[] }>("/api/fs/exists", { paths: slice }, "Could not check file references")));
  const failed = answers.find((got) => !got.ok);
  // Dynamic: report.ts draws into the chat, which imports this module.
  if (failed && !failed.ok) void import("./report.js").then((m) => m.report(failed.error));
  slices.forEach((slice, s) => {
    const got = answers[s]!;
    slice.forEach((path, i) => {
      for (const done of batch.get(path) ?? []) done(got.ok && got.value.exists[i] === true);
    });
  });
}

/** A code span naming a file or a folder opens the dialog, at its line when it
 *  named one. `cwds` resolve a relative path, in order: the writer's own first
 *  (a callback's is the child's), then — for a reply relaying what its
 *  callbacks said — the cwds those callbacks carried; with none it stays plain
 *  code. So does a path with nothing there: a link that opens "No such file"
 *  is a dead link. */
export function renderFileRefs(codes: Iterable<HTMLElement>, sessionId: string, cwds: readonly string[]): void {
  for (const el of codes) {
    const ref = parseFileRef(el.textContent?.trim() ?? "");
    if (!ref || el.closest("a")) continue; // inside a link, the label is the link's
    void locateRef(ref.path, cwds).then((found) => {
      if (found) fileRef(el, sessionId, found.cwd, found.path, ref.line);
    });
  }
}

function fileRef(el: HTMLElement, sessionId: string, cwd: string | null, path: string, line?: number): void {
  const open = (): void => openInFiles(sessionId, cwd, path, line);
  el.classList.add("fileref");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.title = line === undefined ? path : `${path}:${String(line)}`;
  el.onclick = open;
  // A focus ring left on a pressed span reads as a blue box drawn around the
  // prose, and the Files dialog hands focus back when it closes. Keyboard
  // focus keeps its ring: it never arrives with a pointerup.
  el.addEventListener("pointerup", () => el.blur());
  el.onkeydown = (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    open();
  };
}

function thumb(url: string, name: string): HTMLElement {
  const img = imageThumb(url);
  img.alt = name;
  return img;
}

/** Name · type on the left, preview + download on the right. */
function card(url: string, name: string): HTMLElement {
  const sessionId = decodeURIComponent(/^\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? "");
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
    openInFiles(sessionId, null, pathOf(url));
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

/** A set of attachments packs across a row rather than trailing the text one per line. */
function groupAttachments(placed: HTMLElement[]): void {
  const blocks = new Set<HTMLElement>();
  for (const node of placed) if (node.parentElement) blocks.add(node.parentElement);
  for (const block of blocks) {
    const mine = [...block.children].filter((c) => placed.includes(c as HTMLElement));
    const bare = [...block.childNodes].every((n) =>
      n.nodeType === Node.TEXT_NODE ? !n.textContent?.trim() : mine.includes(n as Element),
    );
    // A table cell keeps its display and its row: the strip goes inside it.
    const cell = block.localName === "td" || block.localName === "th";
    if (bare && !cell) {
      block.classList.add("thumbs");
      continue;
    }
    const strip = h("div", "thumbs");
    strip.append(...mine);
    if (cell) block.append(strip);
    else block.after(strip);
  }
}

/** After sanitizing, so only URLs the rewrite produced are touched. */
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
