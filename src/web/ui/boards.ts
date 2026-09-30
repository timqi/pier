// Settings → Boards: the pages agents wrote, and the one decision a human owns
// (publish). Everything else belongs to the agent; this writes only `public`,
// or renames a board away.

import { Check, Ellipsis, X, type IconNode } from "lucide";
import { failure, getJson, refused, sendJson } from "./api.js";
import { copy, h, relTime } from "./dom.js";
import { btn, card, empty, setStatus, toggle } from "./form.js";
import { icon } from "./icons.js";
import { closeMenu, openMenu } from "./menu.js";

/** What /api/boards answers per board (boards/boards.ts `BoardSummary`). */
interface BoardSummary {
  slug: string;
  title: string;
  description: string;
  public: boolean;
  /** Empty until the board is published: the URL's unguessable half. */
  token: string;
  updatedAt: string;
}

/** Where a board is readable: published on the password-free URL its readers
 *  use, the rest on the operator's. One answer for the link and the copy. */
const boardPath = (board: BoardSummary): string =>
  board.public && board.token ? `/p/${board.slug}-${board.token}/` : `/boards/${board.slug}/`;

export function createBoardsPane(): { el: HTMLElement; show(): void } {
  const listBox = h("div", "flex flex-col gap-2");
  const status = h("span", "text-[11.5px]", "");
  // Announced: a copy's only other outcome is an icon swap.
  status.setAttribute("role", "status");

  async function publish(board: BoardSummary, isPublic: boolean): Promise<void> {
    const res = await sendJson(`/api/boards/${board.slug}`, { public: isPublic }, "PATCH");
    if (!res.ok) setStatus(status, "failed", await failure(res, `Could not change ${board.slug}`));
    else setStatus(status, "saved", `${board.slug} is ${isPublic ? "public" : "private"}.`);
    // The URL's token is minted by the write, and a refused switch must flip back.
    await load();
  }

  async function remove(board: BoardSummary): Promise<void> {
    const error = await refused(`/api/boards/${board.slug}`, "DELETE", `Could not delete ${board.slug}`);
    if (error) setStatus(status, "failed", error);
    else setStatus(status, "saved", `Deleted ${board.slug} — the folder is kept as ${board.slug}.deleted-<time>.`);
    await load();
  }

  function row(board: BoardSummary): HTMLElement {
    const link = h("a", "min-w-0 truncate text-[12.5px] font-medium text-neutral-700 hover:text-indigo-700", board.title) as HTMLAnchorElement;
    link.href = boardPath(board);
    link.target = "_blank";
    link.rel = "noreferrer";
    const meta = [board.slug, `updated ${relTime(Date.parse(board.updatedAt))}`];
    if (board.description) meta.push(board.description);
    const line = h(
      "div",
      "flex min-w-0 flex-col gap-1",
      link,
      h("span", "truncate text-[11.5px] text-neutral-400", meta.join(" · ")),
    );
    const sw = toggle("", "", board.public, (v) => void publish(board, v));
    sw.title = "Public: anyone holding the /p/ link can read it, no password";
    sw.querySelector("input")?.setAttribute("aria-label", `Public: ${board.title}`);
    // The track alone is 16px; the finger gets the ⋯'s 44.
    sw.classList.add("max-md:min-h-11", "max-md:px-2");
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
            void copy(`${location.origin}${boardPath(board)}`).then(() => {
              flash(Check);
              setStatus(status, "saved", `Copied ${board.slug}'s link.`);
            }, (err: unknown) => {
              flash(X);
              setStatus(status, "failed", `Could not copy the link: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
        },
        {
          label: "Delete",
          hint: "folder kept",
          separatorBefore: true,
          // The same menu asks again in place; Cancel first, so the focus it
          // lands on is not the delete.
          onSelect: () => openMenu(more, [
            { label: "Cancel", onSelect: closeMenu },
            {
              label: `Delete ${board.slug}`,
              hint: "folder kept",
              separatorBefore: true,
              onSelect: () => {
                closeMenu();
                void remove(board);
              },
            },
          ], `Delete ${board.title}?`),
        },
      ], board.title);
    };
    return h(
      "div",
      "flex items-center justify-between gap-2 rounded-lg border border-neutral-200 py-2 pl-3 pr-1.5",
      line,
      h("div", "flex flex-none items-center gap-1", sw, more),
    );
  }

  async function load(): Promise<void> {
    const got = await getJson<BoardSummary[]>("/api/boards", "Could not load boards");
    if (!got.ok) return void listBox.replaceChildren(empty(got.error));
    listBox.replaceChildren(...(got.value.length
      ? got.value.map(row)
      : [empty("No boards yet. Ask an agent to build one — it writes a folder under ~/.pier/boards.")]));
  }

  // The column every Settings topic sits in (vault.ts).
  const el = h("div", "mx-auto flex w-full min-w-0 max-w-3xl flex-col", card(
    "Boards",
    "Static pages agents wrote, freshest first. A private board opens on a link good for 8 hours; the switch makes it public, on /p/<slug>-<token>/ for anyone holding it.",
    listBox,
    status,
  ));
  return { el, show: () => void load() };
}
