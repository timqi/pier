// Console → Boards view: one table of the static pages agents wrote, and the
// one decision a human owns (publish). Everything else about a board — title,
// description, session links, content — belongs to the agent that wrote it, so
// this view reads /api/boards and writes only `public`.

import { sendJson } from "./api.js";
import { consoleView, h, relTime, type ConsoleView } from "./dom.js";
import { btn, toggle } from "./form.js";

interface Board {
  slug: string;
  title: string;
  description: string;
  sessions: string[];
  public: boolean;
  updatedAt: string;
}

export function createBoardsView(root: HTMLElement, openSession: (id: string) => void): ConsoleView {
  let boards: Board[] = [];
  /**
   * The last write that did not take. A view that silently re-renders the old
   * state is indistinguishable from one where the click never landed.
   */
  let problem = "";

  const header = h(
    "header",
    "sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-neutral-200 bg-white px-4",
    h("span", "font-medium max-md:hidden", "Boards"),
  );
  const pane = h("div", "px-4 py-5");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, pane));

  async function patch(slug: string, isPublic: boolean): Promise<void> {
    const res = await sendJson(`/api/boards/${slug}`, { public: isPublic }, "PATCH");
    if (res.ok) return;
    // The toggle already flipped optimistically; reloading puts it back, and
    // the line says why it moved on its own.
    problem = `Could not change ${slug}: ${res.status}`;
    await load();
  }

  async function remove(slug: string): Promise<void> {
    const res = await fetch(`/api/boards/${slug}`, { method: "DELETE" });
    if (!res.ok) problem = `Could not delete ${slug}: ${res.status}`;
    await load();
  }

  function row(board: Board): HTMLElement {
    const el = h("div", "group flex flex-col gap-1 border-b border-neutral-200/70 px-1 py-2.5 last:border-b-0");
    const link = document.createElement("a");
    link.className = "truncate font-medium text-neutral-800 hover:text-indigo-700";
    link.href = `/boards/${board.slug}/`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = board.title;
    const top = h("div", "flex items-center gap-2", link, h("span", "flex-none font-mono text-[11.5px] text-neutral-400", board.slug));

    // The toggle carries its own consequence: a public board needs no session,
    // no cookie and no invitation to read. Reuses the one switch (form.ts),
    // restyled to sit inline in the row.
    const label = toggle("", "", board.public, (v) => {
      board.public = v;
      void patch(board.slug, v);
    });
    label.className = "ml-auto flex flex-none cursor-pointer items-center gap-1.5 text-[11.5px] text-neutral-500";
    label.append(h("span", "", "Public"));
    // Hover-revealed, like the channel user rows: deleting only renames the
    // folder, so the undo is on disk and a modal would be theatre.
    const del = btn(
      "Delete",
      "flex-none cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100",
    );
    del.title = "Renames the folder on disk; nothing is erased";
    del.onclick = () => void remove(board.slug);
    top.append(label, del);
    el.append(top);

    const meta = h("div", "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-neutral-500");
    if (board.description) meta.append(h("span", "min-w-0 truncate", board.description));
    meta.append(h("span", "flex-none text-neutral-400", relTime(Date.parse(board.updatedAt))));
    for (const id of board.sessions) {
      const chip = btn(id.slice(0, 8), "flex-none cursor-pointer font-mono text-indigo-600 hover:underline");
      chip.title = `Open session ${id}`;
      chip.onclick = () => openSession(id);
      meta.append(chip);
    }
    if (board.public) {
      const url = h("span", "flex-none font-mono text-neutral-400", `/p/${board.slug}/`);
      url.title = "Public URL — anyone who can reach Pier can read this";
      meta.append(url);
    }
    el.append(meta);
    return el;
  }

  // Public first, because that is the list worth double-checking.
  const SECTIONS = [
    { title: "Public", hint: "Readable at /p/<slug>/ by anyone who can reach Pier.", wanted: true },
    { title: "Private", hint: "Reachable from the Console only.", wanted: false },
  ];

  function render(): void {
    const column = h("div", "mx-auto flex max-w-3xl flex-col");
    if (boards.length === 0) {
      column.append(
        h(
          "p",
          "rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-[12.5px] text-neutral-500",
          "No boards yet. Ask an agent to build one — it writes a folder under ~/.pier/boards.",
        ),
      );
    }
    for (const { title, hint, wanted } of SECTIONS) {
      const list = boards.filter((b) => b.public === wanted);
      if (list.length === 0) continue;
      const el = h("section", "mb-6");
      el.append(h("h2", "text-[13px] font-semibold text-neutral-700", title));
      el.append(h("p", "mb-1 text-[11.5px] leading-snug text-neutral-500", hint));
      const box = h("div", "rounded-xl border border-neutral-200 bg-white px-3");
      box.append(...list.map(row));
      el.append(box);
      column.append(el);
    }
    pane.replaceChildren(
      ...(problem ? [h("p", "mb-3 text-[13px] text-red-600", problem)] : []),
      column,
    );
  }

  async function load(): Promise<void> {
    const res = await fetch("/api/boards");
    if (!res.ok) {
      problem = `Could not load boards: ${res.status}`;
      return render();
    }
    boards = (await res.json()) as Board[];
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
