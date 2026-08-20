// Agent attachments in a chat bubble. The agent links a file it produced as
// `[label](file:///abs/path)`; the link is rewritten to the session's files
// route before sanitizing (DOMPurify drops `file:` URLs, and rightly so), then
// the rendered node is upgraded: images become thumbnails, everything else an
// attachment card with preview + download.

import { $, h } from "./dom.js";

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
const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

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

function thumb(url: string, name: string, openImage: (src: string) => void): HTMLElement {
  const img = document.createElement("img");
  img.src = url;
  img.alt = name;
  img.loading = "lazy";
  img.className = "mt-1.5 max-h-48 cursor-zoom-in rounded-md border border-black/5";
  img.onclick = () => openImage(url);
  return img;
}

/** Name · type on the left, preview + download on the right. */
function card(url: string, name: string): HTMLElement {
  const ext = extOf(name);
  const wrap = h(
    "span",
    "my-1 inline-flex max-w-full items-center gap-2.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 align-middle no-underline",
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
 * Upgrade every attachment node of a rendered markdown bubble in place. Called
 * after sanitizing, so only URLs the rewrite produced are touched.
 */
export function renderAttachments(root: HTMLElement, openImage: (src: string) => void): void {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!isFileUrl(src)) continue;
    img.replaceWith(thumb(src, basename(pathOf(src)), openImage));
  }
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (!isFileUrl(href)) continue;
    const name = basename(pathOf(href)) || a.textContent?.trim() || "file";
    a.replaceWith(
      IMAGE_EXT.has(extOf(name)) ? thumb(href, name, openImage) : card(href, name),
    );
  }
}
