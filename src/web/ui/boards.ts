// Console → Boards view: one table of the static pages agents wrote, and the
// one decision a human owns (publish). Everything else about a board — title,
// description, session links, content — belongs to the agent that wrote it, so
// this view reads /api/boards and writes only `public`.

import { h, relTime } from "./dom.js";

interface Board {
  slug: string;
  title: string;
  description: string;
  sessions: string[];
  public: boolean;
  updatedAt: string;
}

export interface BoardsView {
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

export function createBoardsView(root: HTMLElement, openSession: (id: string) => void): BoardsView {
  let visible = false;
  let boards: Board[] = [];

  const header = h("header", "sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-neutral-200 bg-white px-4");
  header.append(h("span", "font-medium max-md:hidden", "Boards"));
  const pane = h("div", "px-4 py-5");
  const scroll = h("div", "min-h-0 flex-1 overflow-y-auto");
  scroll.append(header, pane);
  root.append(scroll);

  async function patch(slug: string, isPublic: boolean): Promise<void> {
    const res = await fetch(`/api/boards/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public: isPublic }),
    });
    if (!res.ok) await load();
  }

  async function remove(slug: string): Promise<void> {
    await fetch(`/api/boards/${slug}`, { method: "DELETE" });
    await load();
  }

  function row(board: Board): HTMLElement {
    const el = h("div", "group flex flex-col gap-1 border-b border-neutral-200/70 px-1 py-2.5 last:border-b-0");
    const top = h("div", "flex items-center gap-2");
    const link = document.createElement("a");
    link.className = "truncate font-medium text-neutral-800 hover:text-indigo-700";
    link.href = `/boards/${board.slug}/`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = board.title;
    top.append(link, h("span", "flex-none font-mono text-[11.5px] text-neutral-400", board.slug));

    // The toggle carries its own consequence: a public board needs no session,
    // no cookie and no invitation to read.
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "peer sr-only";
    toggle.checked = board.public;
    toggle.onchange = () => {
      board.public = toggle.checked;
      void patch(board.slug, toggle.checked);
    };
    const label = h("label", "ml-auto flex flex-none cursor-pointer items-center gap-1.5 text-[11.5px] text-neutral-500");
    label.append(
      toggle,
      h(
        "span",
        "relative h-4 w-7 flex-none rounded-full bg-neutral-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-indigo-600 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-200",
      ),
      h("span", "", "Public"),
    );
    // Hover-revealed, like the channel user rows: deleting only renames the
    // folder, so the undo is on disk and a modal would be theatre.
    const del = h(
      "button",
      "flex-none cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100",
      "Delete",
    ) as HTMLButtonElement;
    del.type = "button";
    del.title = "Renames the folder on disk; nothing is erased";
    del.onclick = () => void remove(board.slug);
    top.append(label, del);
    el.append(top);

    const meta = h("div", "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-neutral-500");
    if (board.description) meta.append(h("span", "min-w-0 truncate", board.description));
    meta.append(h("span", "flex-none text-neutral-400", relTime(Date.parse(board.updatedAt))));
    for (const id of board.sessions) {
      const chip = h("button", "flex-none cursor-pointer font-mono text-indigo-600 hover:underline", id.slice(0, 8));
      (chip as HTMLButtonElement).type = "button";
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
    pane.replaceChildren(column);
  }

  async function load(): Promise<void> {
    const res = await fetch("/api/boards");
    if (!res.ok) return;
    boards = (await res.json()) as Board[];
    render();
  }

  // No SSE for boards: they change when an agent writes files, and a refetch on
  // focus is closer to free than a second event stream.
  window.addEventListener("focus", () => {
    if (visible) void load();
  });

  return {
    show() {
      visible = true;
      root.classList.remove("hidden");
      root.classList.add("flex");
      void load();
    },
    hide() {
      visible = false;
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
    get visible() {
      return visible;
    },
  };
}
