// Settings → Boards: where this instance's public boards go (the Pages
// project), and the pages agents wrote with what is live. This writes the two
// settings, runs `pier boards publish`'s flow in Pier's process, or renames a
// board away.

import { Check, Ellipsis, X, type IconNode } from "lucide";
import { failure, getJson, refused, sendJson } from "./api.js";
import { copy, h, relTime } from "./dom.js";
import { badge, btn, button, card, empty, field, input, setStatus } from "./form.js";
import { icon } from "./icons.js";
import { closeMenu, openMenu } from "./menu.js";

/** What /api/boards answers per board (boards/boards.ts `BoardSummary`). */
interface BoardSummary {
  slug: string;
  title: string;
  description: string;
  public: boolean;
  /** Present only while the board is in the live Pages snapshot. */
  url?: string;
  publishedAt?: string;
  /** The folder is renamed away, but the board is still on Pages. */
  deleted?: true;
  updatedAt: string;
}

/** One frame of POST /api/boards/publish (boards/publish.ts `PublishFrame`). */
type PublishFrame = { out: string } | { err: string } | { log: string } | { exit: number };

/** Where a board is readable: live on Pages at its `url`, else on the
 *  operator's prefix. One answer for the link and the copy. */
const boardLink = (board: BoardSummary): string => board.url ?? `/boards/${board.slug}/`;

/** A link that opens in a new tab and sends no referrer: every board link. */
function external(href: string, cls: string, label = href): HTMLAnchorElement {
  const link = h("a", cls, label) as HTMLAnchorElement;
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

/** The six states of docs/design/05-boards.md: intent (`public`) against fact (`url`). */
function state(board: BoardSummary): string {
  if (board.deleted) return "deleted · still live";
  if (!board.public) return board.url ? "unpublish pending" : "private";
  if (!board.url) return "publish pending";
  return board.publishedAt && board.publishedAt < board.updatedAt ? "published · changes unpublished" : "published";
}

export function createBoardsPane(): { el: HTMLElement; show(): void } {
  const listBox = h("div", "flex flex-col gap-2");
  const status = h("span", "text-[11.5px]", "");
  // Announced: a copy's only other outcome is an icon swap.
  status.setAttribute("role", "status");

  // --- Publishing: the Pages project ------------------------------------------
  const projectInput = input();
  projectInput.placeholder = "pier-<instance>";
  projectInput.autocomplete = "off";
  projectInput.spellcheck = false;
  const addressInput = input();
  addressInput.placeholder = "https://<project>.pages.dev";
  addressInput.autocomplete = "off";
  const pagesStatus = h("span", "text-[11.5px]", "");
  const pagesSave = button("Save", true);

  async function savePages(): Promise<void> {
    setStatus(pagesStatus, "saving", "saving…");
    const res = await sendJson("/api/settings", { pages: { project: projectInput.value, url: addressInput.value } }, "PUT");
    if (!res.ok) return setStatus(pagesStatus, "failed", await failure(res, "Could not save"));
    const { pagesProject, pagesUrl } = (await res.json()) as { pagesProject: string; pagesUrl: string };
    projectInput.value = pagesProject;
    addressInput.value = pagesUrl;
    setStatus(pagesStatus, "saved", pagesProject ? `Saved — public boards publish to ${pagesUrl || `https://${pagesProject}.pages.dev`}/<slug>/` : "Cleared — this instance publishes no board.");
  }
  pagesSave.onclick = () => void savePages();
  for (const el of [projectInput, addressInput]) {
    el.onkeydown = (ev) => {
      if (ev.key === "Enter") void savePages();
    };
  }

  async function loadPages(): Promise<void> {
    const got = await getJson<{ pagesProject: string; pagesUrl: string }>("/api/settings", "Could not load settings");
    if (!got.ok) return setStatus(pagesStatus, "failed", got.error);
    projectInput.value = got.value.pagesProject;
    addressInput.value = got.value.pagesUrl;
  }

  // --- Publish: the button's run of pier boards publish ------------------------
  const publishBtn = button("Publish");
  const publishStatus = h("span", "text-[11.5px]", "");
  publishStatus.setAttribute("role", "status");
  const publishLog = h("pre", "hidden max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-3 text-[11.5px] leading-snug text-neutral-700");
  const publishResult = h("div", "flex flex-col gap-1 text-[12px] text-neutral-700");

  function resultLine(line: string): HTMLElement {
    const url = /^published (https?:\/\/\S+)$/.exec(line)?.[1];
    if (!url) return h("span", "break-words", line);
    return h("span", "", "published ", external(url, "break-all text-indigo-700 hover:underline"));
  }

  /** Draws one frame; the exit code is the stream's last, returned. */
  function frame(f: PublishFrame): number | undefined {
    if ("log" in f) {
      publishLog.classList.remove("hidden");
      publishLog.textContent += f.log;
      publishLog.scrollTop = publishLog.scrollHeight;
    } else if ("out" in f) publishResult.append(resultLine(f.out));
    else if ("err" in f) publishResult.append(h("span", "break-words text-red-600", f.err));
    else return f.exit;
    return undefined;
  }

  async function publish(): Promise<void> {
    publishBtn.disabled = true;
    publishLog.classList.add("hidden");
    publishLog.textContent = "";
    publishResult.replaceChildren();
    setStatus(publishStatus, "saving", "Publishing — wrangler runs on the server; approve its credentials if your phone asks.");
    let exit: number | undefined;
    let lost = "";
    try {
      const res = await sendJson("/api/boards/publish", {});
      if (!res.ok || !res.body) return setStatus(publishStatus, "failed", await failure(res, "Could not publish"));
      // SSE frames over a POST: EventSource cannot send one.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const raw of frames) {
          const data = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) exit = frame(JSON.parse(data) as PublishFrame) ?? exit;
        }
      }
    } catch (err) {
      lost = `: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      publishBtn.disabled = false;
    }
    if (exit === 0) setStatus(publishStatus, "saved", "Published.");
    else if (exit === undefined) setStatus(publishStatus, "failed", `Connection lost${lost} — the publish may still be running on the server; the list below shows what it wrote.`);
    else setStatus(publishStatus, "failed", "Publish failed — the boards: line above says where.");
    await loadList();
  }
  publishBtn.onclick = () => void publish();

  async function remove(board: BoardSummary): Promise<void> {
    const error = await refused(`/api/boards/${board.slug}`, "DELETE", `Could not delete ${board.slug}`);
    if (error) setStatus(status, "failed", error);
    else {
      setStatus(status, "saved", `Deleted ${board.slug} — the folder is kept as ${board.slug}.deleted-<time>.` +
        (board.url ? ` Still live at ${board.url} until the next publish.` : ""));
    }
    await loadList();
  }

  function row(board: BoardSummary): HTMLElement {
    const link = external(boardLink(board), "min-w-0 truncate text-[12.5px] font-medium text-neutral-700 hover:text-indigo-700", board.title);
    const meta = [board.slug, state(board), `updated ${relTime(Date.parse(board.updatedAt))}`];
    if (board.description) meta.push(board.description);
    // Live on Pages: said by a badge and the address itself, not only by the state words.
    const title = board.url ? h("span", "flex min-w-0 items-center gap-2", link, badge("Public", "bg-green-50 text-green-700 ring-green-200")) : link;
    const address = board.url ? [external(board.url, "min-w-0 truncate text-[11.5px] text-indigo-700 hover:underline")] : [];
    const line = h(
      "div",
      "flex min-w-0 flex-col gap-1",
      title,
      ...address,
      h("span", "truncate text-[11.5px] text-neutral-400", meta.join(" · ")),
    );
    // One trigger instead of a row of words, so the title keeps the width.
    const more = btn("", "icon-btn max-md:h-11 max-md:w-11");
    more.append(icon(Ellipsis));
    more.title = "Board actions";
    more.setAttribute("aria-label", `Actions for ${board.title}`);
    more.setAttribute("aria-haspopup", "true");
    // The menu is gone by the time the clipboard answers; the trigger says it.
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const flash = (glyph: IconNode): void => {
      more.replaceChildren(icon(glyph));
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => more.replaceChildren(icon(Ellipsis)), 1200);
    };
    more.onclick = () => {
      if (more.getAttribute("aria-expanded") === "true") return closeMenu();
      openMenu(more, [
        {
          label: "Copy link",
          onSelect: () => {
            closeMenu();
            // Absolute: a copied link is going to a chat or another machine.
            void copy(board.url ?? `${location.origin}${boardLink(board)}`).then(() => {
              flash(Check);
              setStatus(status, "saved", `Copied ${board.slug}'s link.`);
            }, (err: unknown) => {
              flash(X);
              setStatus(status, "failed", `Could not copy the link: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
        },
        // A deleted board's folder is already renamed; only the publish takes it down.
        ...(board.deleted ? [] : [{
          label: "Delete",
          hint: board.url ? "folder kept, stays live" : "folder kept",
          separatorBefore: true,
          // The same menu asks again in place; Cancel first, so the focus it
          // lands on is not the delete.
          onSelect: () => openMenu(more, [
            { label: "Cancel", onSelect: closeMenu },
            {
              label: `Delete ${board.slug}`,
              hint: board.url ? `still live at ${board.url}` : "folder kept",
              separatorBefore: true,
              onSelect: () => {
                closeMenu();
                void remove(board);
              },
            },
          ], `Delete ${board.title}?`),
        }]),
      ], board.title);
    };
    return h(
      "div",
      "flex items-center justify-between gap-2 rounded-lg border border-neutral-200 py-2 pl-3 pr-1.5",
      line,
      h("div", "flex flex-none items-center gap-1", more),
    );
  }

  async function load(): Promise<void> {
    void loadPages();
    await loadList();
  }

  async function loadList(): Promise<void> {
    const got = await getJson<BoardSummary[]>("/api/boards", "Could not load boards");
    if (!got.ok) return void listBox.replaceChildren(empty(got.error));
    listBox.replaceChildren(...(got.value.length
      ? got.value.map(row)
      : [empty("No boards yet. Ask an agent to build one — it writes a folder under ~/.pier/boards.")]));
  }

  // The column every Settings topic sits in (vault.ts).
  const el = h("div", "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4", card(
    "Publishing",
    "Public boards are pushed to this Cloudflare Pages project by Publish here or pier boards publish in a shell; either runs wrangler from its own PATH. Bind a custom domain in the Cloudflare dashboard and name it here.",
    field("Project", projectInput, { hint: "Empty: this instance publishes no board. One project per instance; two instances on one name overwrite each other." }),
    field("Address", addressInput, { hint: "Optional — the custom domain; empty means https://<project>.pages.dev." }),
    h("div", "flex items-center gap-3", pagesSave, pagesStatus),
    h("div", "flex items-center gap-3", publishBtn, publishStatus),
    publishResult,
    publishLog,
  ), card(
    "Boards",
    "Static pages agents wrote, freshest first. A private board opens on a link good for 8 hours; a board whose manifest says public: true goes live on the next publish.",
    listBox,
    status,
  ));
  return { el, show: () => void load() };
}
