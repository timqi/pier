// Console → Boards view: one table of the static pages agents wrote, and the
// one decision a human owns (publish). Everything else about a board — title,
// description, session links, content — belongs to the agent that wrote it, so
// this view reads /api/boards and writes only `public`.

import { failure, getJson, refused, sendJson } from "./api.js";
import { consoleView, copyBtn, h, relTime, type ConsoleView } from "./dom.js";
import { btn, card, empty, pageTitle, toggle } from "./form.js";

interface Board {
  slug: string;
  title: string;
  description: string;
  sessions: string[];
  public: boolean;
  /** Empty until the board is published: the URL's unguessable half. */
  token: string;
  updatedAt: string;
}

/** Where this board is readable: published boards on the password-free URL its
 *  readers use, the rest on the operator's. One answer, so the row's title, its
 *  copy button and the address it prints can never disagree. */
const boardPath = (board: Board): string =>
  board.public && board.token ? `/p/${board.slug}-${board.token}/` : `/boards/${board.slug}/`;

export function createBoardsView(root: HTMLElement, openSession: (id: string) => void): ConsoleView {
  let boards: Board[] = [];
  /**
   * The last write that did not take. A view that silently re-renders the old
   * state is indistinguishable from one where the click never landed.
   */
  let problem = "";

  // max-md:hidden: the title is all this head carries, and below md the top bar
  // already says "Boards" — the strip would be an empty band under it.
  // top-[-8px] is the strip's own inset, so once it sticks it sits flush
  // against the scrollport instead of leaving 8px of cards sliding past above.
  const header = h("header", "pagehead sticky top-[-8px] z-30 max-md:hidden", pageTitle("Boards"));
  const pane = h("div", "px-4 pb-5 pt-1");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, pane));

  async function patch(board: Board, isPublic: boolean): Promise<void> {
    const res = await sendJson(`/api/boards/${board.slug}`, { public: isPublic }, "PATCH");
    if (res.ok) {
      // The URL's token is minted by the write, so an optimistic row cannot
      // draw the link — this answer is the first place it exists.
      board.token = ((await res.json().catch(() => ({}))) as { token?: string }).token ?? "";
      return render();
    }
    // The toggle already flipped optimistically; reloading puts it back, and
    // the line says why it moved on its own.
    problem = await failure(res, `Could not change ${board.slug}`);
    await load();
  }

  async function remove(slug: string): Promise<void> {
    problem = (await refused(`/api/boards/${slug}`, "DELETE", `Could not delete ${slug}`)) ?? "";
    await load();
  }

  function row(board: Board): HTMLElement {
    const el = h("div", "group flex flex-col gap-1 py-2.5");
    const link = document.createElement("a");
    // basis-full below md: the row's controls would otherwise squeeze the title
    // to nothing on a phone, so there the name takes the line by itself.
    link.className =
      "min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 hover:text-indigo-700 max-md:basis-full";
    // A public board opens on the URL its readers use: the password-free one,
    // so what the operator checks is the page anyone else gets.
    link.href = boardPath(board);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = board.title;
    const top = h("div", "flex flex-wrap items-center gap-x-2 gap-y-1", link);

    // The toggle carries its own consequence: a public board needs no session,
    // no cookie and no invitation to read. Reuses the one switch (form.ts),
    // restyled to sit inline in the row.
    const label = toggle("", "", board.public, (v) => {
      board.public = v;
      void patch(board, v);
    });
    label.className = "flex flex-none cursor-pointer items-center gap-1.5 text-[11.5px] text-neutral-500";
    label.append(h("span", "", "Public"));
    // Hover-revealed, like the channel user rows: deleting only renames the
    // folder, so the undo is on disk and a modal would be theatre.
    const del = btn(
      "Delete",
      "flex-none cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100 pointer-coarse:opacity-100",
    );
    del.title = "Renames the folder on disk; nothing is erased";
    del.onclick = () => void remove(board.slug);
    // Absolute, because a copied link is going somewhere else: a chat, a mail,
    // another machine. `board` is read at click time, so a toggle flipped a
    // second ago copies the URL the row now shows.
    const copyLink = copyBtn(
      "flex-none cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-indigo-600 group-hover:opacity-100 pointer-coarse:opacity-100",
      () => `${location.origin}${boardPath(board)}`,
    );
    copyLink.title = "Copy the board's link";
    top.append(h("div", "ml-auto flex flex-none items-center gap-2", label, copyLink, del));
    el.append(top);

    // The slug leads the meta line rather than the title's: it is the folder's
    // name, and beside the title it was the thing crowding it out.
    const meta = h("div", "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-neutral-500");
    meta.append(h("span", "min-w-0 break-all font-mono text-neutral-400", board.slug));
    if (board.description) meta.append(h("span", "min-w-0 truncate", board.description));
    meta.append(h("span", "flex-none text-neutral-400", relTime(Date.parse(board.updatedAt))));
    for (const id of board.sessions) {
      const chip = btn(id.slice(0, 8), "flex-none cursor-pointer font-mono text-indigo-600 hover:underline");
      chip.title = `Open session ${id}`;
      chip.onclick = () => openSession(id);
      meta.append(chip);
    }
    if (board.public && board.token) {
      const url = h("span", "min-w-0 break-all font-mono text-neutral-400", boardPath(board));
      url.title = "Public URL — anyone holding this link can read the board, no password";
      meta.append(url);
    }
    el.append(meta);
    return el;
  }

  // Public first, because that is the list worth double-checking.
  const SECTIONS = [
    { title: "Public", hint: "Readable at /p/<slug>-<token>/ by anyone holding the link.", wanted: true },
    { title: "Private", hint: "Reachable from the Console only.", wanted: false },
  ];

  function render(): void {
    // One card per section, the Console's own: a page of boards is a page of
    // cards on the canvas, like every other Console page.
    const column = h("div", "mx-auto flex w-full max-w-3xl flex-col gap-4");
    if (boards.length === 0) {
      column.append(empty("No boards yet. Ask an agent to build one — it writes a folder under ~/.pier/boards."));
    }
    for (const { title, hint, wanted } of SECTIONS) {
      const list = boards.filter((b) => b.public === wanted);
      if (list.length === 0) continue;
      column.append(card(title, hint, h("div", "flex flex-col divide-y divide-neutral-200/70", ...list.map(row))));
    }
    pane.replaceChildren(
      ...(problem ? [h("p", "mb-3 text-[13px] text-red-600", problem)] : []),
      column,
    );
  }

  async function load(): Promise<void> {
    const got = await getJson<Board[]>("/api/boards", "Could not load boards");
    if (!got.ok) {
      problem = got.error;
      return render();
    }
    boards = got.value;
    render();
    // Cleared only after a good render, so the reason survives the reload it
    // triggered and disappears on the next clean one.
    problem = "";
  }

  const view = consoleView(root, () => void load());
  // No SSE for boards: they change when an agent writes files, and a refetch on
  // focus is closer to free than a second event stream.
  window.addEventListener("focus", () => {
    if (view.visible) void load();
  });
  return view;
}
