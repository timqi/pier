// Settings → Boards: where this instance's public boards go (the Pages
// project), and the pages agents wrote with what is live. Publishing itself is
// `pier boards publish`, an agent's command; this writes the two settings, or
// renames a board away.

import { Check, Ellipsis, X, type IconNode } from "lucide";
import { failure, getJson, refused, sendJson } from "./api.js";
import { copy, h, relTime } from "./dom.js";
import { btn, button, card, empty, field, input, setStatus } from "./form.js";
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

/** Where a board is readable: live on Pages at its `url`, else on the
 *  operator's prefix. One answer for the link and the copy. */
const boardLink = (board: BoardSummary): string => board.url ?? `/boards/${board.slug}/`;

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

  async function remove(board: BoardSummary): Promise<void> {
    const error = await refused(`/api/boards/${board.slug}`, "DELETE", `Could not delete ${board.slug}`);
    if (error) setStatus(status, "failed", error);
    else {
      setStatus(status, "saved", `Deleted ${board.slug} — the folder is kept as ${board.slug}.deleted-<time>.` +
        (board.url ? ` Still live at ${board.url} until an agent runs pier boards publish.` : ""));
    }
    await load();
  }

  function row(board: BoardSummary): HTMLElement {
    const link = h("a", "min-w-0 truncate text-[12.5px] font-medium text-neutral-700 hover:text-indigo-700", board.title) as HTMLAnchorElement;
    link.href = boardLink(board);
    link.target = "_blank";
    link.rel = "noreferrer";
    const meta = [board.slug, state(board), `updated ${relTime(Date.parse(board.updatedAt))}`];
    if (board.description) meta.push(board.description);
    const line = h(
      "div",
      "flex min-w-0 flex-col gap-1",
      link,
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
    const got = await getJson<BoardSummary[]>("/api/boards", "Could not load boards");
    if (!got.ok) return void listBox.replaceChildren(empty(got.error));
    listBox.replaceChildren(...(got.value.length
      ? got.value.map(row)
      : [empty("No boards yet. Ask an agent to build one — it writes a folder under ~/.pier/boards.")]));
  }

  // The column every Settings topic sits in (vault.ts).
  const el = h("div", "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4", card(
    "Publishing",
    "Public boards are pushed to this Cloudflare Pages project by an agent running pier boards publish. Bind a custom domain in the Cloudflare dashboard and name it here.",
    field("Project", projectInput, { hint: "Empty: this instance publishes no board. One project per instance; two instances on one name overwrite each other." }),
    field("Address", addressInput, { hint: "Optional — the custom domain; empty means https://<project>.pages.dev." }),
    h("div", "flex items-center gap-3", pagesSave, pagesStatus),
  ), card(
    "Boards",
    "Static pages agents wrote, freshest first. A private board opens on a link good for 8 hours; a board whose manifest says public: true goes live on the next pier boards publish.",
    listBox,
    status,
  ));
  return { el, show: () => void load() };
}
