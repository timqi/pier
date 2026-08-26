// Console → Bus view: the shared blackboard's first visible surface — the
// state that exists, who listens to it, what delivery is still owed, and what
// just happened. One tab each, because four full sections on one page is a
// scroll nobody reads to the end of. Read-only; the single write here is the
// capability switch, which lives on this page because this is where its
// consequences show.

import { failure, sendJson } from "./api.js";
import { basename, consoleView, h, relTime, type ConsoleView } from "./dom.js";
import { badge, btn, button, empty, select, setStatus, tabButton, textInput, toggle } from "./form.js";
// Type-only: the wire shapes stay single-sourced in the area that fills them.
import type {
  BusEventRow,
  BusFactRow,
  BusNoteRow,
  BusOverview,
  BusSubRow,
  BusTopicRow,
} from "../../bus/types.js";

export type BusView = ConsoleView & { refresh(): void };

const EMPTY: BusOverview = {
  enabled: false,
  librarians: [],
  topics: [], topicsTotal: 0,
  subs: [], subsTotal: 0,
  notes: [], notesTotal: 0,
  events: [], eventsTotal: 0,
};

type Tab = "topics" | "subs" | "owed" | "events";
const TABS: [Tab, string][] = [
  ["topics", "Topics"],
  ["subs", "Subscriptions"],
  ["owed", "Deliveries owed"],
  ["events", "Recent events"],
];
const isTab = (v: string | undefined): v is Tab => TABS.some(([id]) => id === v);

// --- vocabulary ------------------------------------------------------------------
// Three badge families, tinted like the rest of the Console: the neutral thing,
// the thing that overrides, the thing that is wrong.

/** A scope named the way a human reads it, with the raw string on hover — a
 *  `project:/very/long/abs/path` is a column of its own otherwise. */
function scopeBadge(scope: string): HTMLElement {
  const [kind = scope, rest = ""] = scope.startsWith("run:")
    ? ["run", scope.slice(4)]
    : scope.startsWith("project:")
    ? ["project", scope.slice(8)]
    : [scope, ""];
  const label = kind === "run" ? `run ${rest.slice(0, 8)}` : kind === "project" ? basename(rest) : kind;
  const el = badge(label, kind === "run"
    ? "bg-amber-50 text-amber-700 ring-amber-200"
    : kind === "project"
    ? "bg-indigo-50 text-indigo-700 ring-indigo-200"
    : "bg-sky-50 text-sky-700 ring-sky-200");
  el.title = scope;
  return el;
}

const kindBadge = (kind: BusEventRow["kind"]): HTMLElement =>
  badge(kind, kind === "fact"
    ? "bg-indigo-50 text-indigo-700 ring-indigo-200"
    : kind === "tombstone"
    ? "bg-red-50 text-red-700 ring-red-200"
    : "bg-neutral-100 text-neutral-600 ring-neutral-200");

const stateBadge = (state: string): HTMLElement =>
  badge(state, state === "abandoned"
    ? "bg-red-50 text-red-700 ring-red-200"
    : state === "failed"
    ? "bg-amber-50 text-amber-700 ring-amber-200"
    : "bg-neutral-100 text-neutral-600 ring-neutral-200");

/** A payload preview: text, always. Nothing on this page renders agent-written
 *  content as markup (dom.ts's rule), so a payload is a text node in a <span>. */
const mono = (text: string): HTMLElement =>
  h("span", "break-all font-mono text-[11.5px] text-neutral-600", text);

// No truncation on the cell itself: badges and scopes wrap, and a clipped
// second line is how a pinned scope disappears. What must stay on one line
// says so on the inner span.
const cell = (...children: (Node | string)[]): HTMLElement =>
  h("td", "px-3 py-2 align-top", ...children);

function row(...cells: HTMLElement[]): HTMLElement {
  const tr = document.createElement("tr");
  tr.className = "border-t border-neutral-100";
  tr.append(...cells);
  return tr;
}

/** A table wearing the Tasks list's chrome, built without innerHTML. */
function table(headers: [string, string][], rows: HTMLElement[]): HTMLElement {
  const el = document.createElement("table");
  el.className = "w-full min-w-[44rem] table-fixed text-left text-[12.5px]";
  const head = document.createElement("thead");
  head.className = "bg-neutral-50 text-[10.5px] uppercase text-neutral-400";
  const tr = document.createElement("tr");
  for (const [label, width] of headers) tr.append(h("th", `${width} px-3 py-2 font-semibold`, label));
  head.append(tr);
  const body = document.createElement("tbody");
  body.append(...rows);
  el.append(head, body);
  return h("div", "overflow-x-auto rounded-xl border border-neutral-200 bg-white", el);
}

export function createBusView(
  root: HTMLElement,
  openSession: (id: string) => void,
  /** Tab clicks route (#/bus/<tab>) so refresh and Back keep the tab. */
  onTab: (tab: string) => void,
  /** The workbench's project inventory — distinct session cwds, derived, the
   *  same list Files, Terminal and Settings pick from. There is no project
   *  store to ask (docs/architecture.md). */
  projects: () => string[],
  /** A seeded librarian is an ordinary task, so its row links to the panel that
   *  owns it instead of growing a second editor here. */
  openTask: (taskId: string) => void,
  /** The switch below is also read elsewhere — the rail's Desk row is gated on
   *  it — so flipping it here tells the page that drew the other surface. */
  onSwitched: () => void,
): BusView {
  let data: BusOverview = EMPTY;
  let loaded = false;
  let tab: Tab = "topics";
  /** Sent to the server, not applied here: the page is 200 rows of a table
   *  with no ceiling, so a box that only sifted what had loaded could not see
   *  the 201st topic at all — which is most of what an operator opens this
   *  page to find. */
  let query = "";
  /** The last read or write that did not take. A view that re-renders the old
   *  state silently is indistinguishable from one nobody clicked. */
  let problem = "";
  /** Which `load()` is current; see the comment there. */
  let generation = 0;
  const switchStatus = h("span", "text-[11.5px]", "");

  const header = h(
    "header",
    "sticky top-0 z-30 flex h-10 flex-none items-center gap-3 border-b border-neutral-200 bg-white px-4",
    h("span", "font-medium max-md:hidden", "Bus"),
  );
  const pane = h("div", "px-4 py-5");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, pane));

  const sessionChip = (id: string): HTMLElement => {
    const chip = btn(id.slice(0, 8), "cursor-pointer font-mono text-[11.5px] text-indigo-600 hover:underline");
    chip.title = `Open session ${id}`;
    chip.onclick = () => openSession(id);
    return chip;
  };

  // --- the switch -------------------------------------------------------------

  const HINT = "Off hides the bus tool from new sessions and freezes owed notifications; nothing is deleted. A session mid-turn keeps the tools it started with; the next message picks this up.";

  /** Drawn from confirmed state, never from the click: the switch must not
   *  show something nobody stored. */
  const busSwitch = (): HTMLElement =>
    toggle("Session bus", HINT, data.enabled, (checked) => void save(checked));

  async function save(checked: boolean): Promise<void> {
    setStatus(switchStatus, "saving", "saving…");
    const res = await sendJson("/api/settings", { busEnabled: checked }, "PUT");
    if (!res.ok) {
      setStatus(switchStatus, "failed", await failure(res, "Could not save"));
      return render();
    }
    data = { ...data, enabled: ((await res.json()) as { busEnabled: boolean }).busEnabled };
    setStatus(
      switchStatus,
      "saved",
      data.enabled ? "On — sessions take it on their next message." : "Off — hidden from the next session.",
    );
    // Re-read rather than trust the flip: enabling reveals whatever the tables
    // were already holding from the last time it was on.
    onSwitched();
    await load();
  }

  // --- the librarian ----------------------------------------------------------
  // Detection, not stored state: whether this offers to seed a librarian or
  // names the one already maintaining the chosen project is a question the task
  // store answers on every load. Nothing here records that a librarian was
  // seeded — the task is the only thing that could make it true, and a control
  // must not draw a state nobody stored.

  const seedStatus = h("span", "text-[11.5px]", "");
  /** The project the picker is on. Re-pinned to the inventory whenever the
   *  picker opens, so a cwd whose last session is gone cannot linger. */
  let seedCwd = "";
  /** The picker is what "Seed…" opens; the control is one line the rest of the
   *  time. A section for it was a page's worth of chrome around one button. */
  let picking = false;
  const librarianBar = h("div", "mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]");

  function renderLibrarian(): void {
    const line: (Node | string)[] = [h("span", "flex-none text-neutral-500", "Librarian:")];
    // Detected on every load, so this line reports what the task store holds —
    // several when several projects have one, and nothing invented when none do.
    for (const row of data.librarians) {
      const open = btn(`${row.cwd} · ${row.schedule}`, "cursor-pointer text-indigo-600 hover:underline");
      open.title = `Open ${row.name} in Tasks — the panel that owns its schedule, prompt, pause and delete`;
      open.onclick = () => openTask(row.taskId);
      line.push(open, ...(row.enabled ? [] : [badge("paused", "bg-amber-50 text-amber-700 ring-amber-200")]));
    }
    if (!data.librarians.length) line.push(h("span", "text-neutral-400", "none"));
    const cwds = projects();
    // Disabled always says why: a dead control with no reason beside it is
    // indistinguishable from a broken one.
    const blocked = !data.enabled
      ? "the bus is off — a librarian's runs would find no bus tool to work with"
      : cwds.length === 0
      ? "no projects yet — a librarian maintains a session's working directory"
      : "";
    if (picking) {
      if (!cwds.includes(seedCwd)) seedCwd = cwds[0] ?? "";
      const picker = select(cwds.map((cwd) => [cwd, cwd] as [string, string]), seedCwd);
      picker.disabled = cwds.length === 0;
      // The status belongs to the project it was about: keeping "already
      // maintains /a" beside a button now aimed at /b would be a lie.
      picker.onchange = () => {
        seedCwd = picker.value;
        setStatus(seedStatus, "idle", "");
      };
      const seed = button("Seed", true);
      seed.disabled = blocked !== "";
      seed.onclick = () => void createLibrarian();
      line.push(h("span", "w-72 max-w-full flex-none", picker), seed);
    } else {
      const start = btn("Seed…", "cursor-pointer text-indigo-600 hover:underline");
      start.title = blocked
        || "Create the daily bus-librarian task for a project: distill, archive, propose (docs/bus.md)";
      start.onclick = () => {
        picking = true;
        renderLibrarian();
      };
      line.push(h("span", "text-neutral-300", "·"), start);
    }
    if (blocked) line.push(h("span", "text-neutral-400", `— ${blocked}`));
    librarianBar.replaceChildren(...line, seedStatus);
  }

  async function createLibrarian(): Promise<void> {
    setStatus(seedStatus, "saving", "creating…");
    const res = await sendJson("/api/bus/librarian", { cwd: seedCwd });
    if (!res.ok) {
      setStatus(seedStatus, "failed", await failure(res, "Could not seed the librarian"));
      return;
    }
    picking = false;
    setStatus(seedStatus, "saved", "Created — the Tasks panel owns it now.");
    // Re-read rather than patch the row in: the created task is the state, and
    // this page shows what the store holds.
    await load();
  }

  // --- rows -------------------------------------------------------------------

  /** Which topic rows the reader had expanded, so a live refetch does not
   *  collapse what they were reading. Keyed by (topic, scope), the row's own
   *  identity — an index would drift the moment a topic moves up the list. */
  const opened = new Set<string>();

  function topicRow(topic: BusTopicRow): HTMLElement {
    const id = `${topic.topic}\n${topic.scope}`;
    const counts = [
      `${topic.events} live`,
      ...(topic.archived ? [`${topic.archived} archived`] : []),
      `newest ${relTime(Date.parse(topic.newestAt))}`,
      topic.lastReadAt === null ? "never read" : `read ${relTime(topic.lastReadAt)}`,
    ].join(" · ");
    const head = h(
      "div",
      "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
      h("span", "truncate font-medium text-neutral-800", topic.topic),
      scopeBadge(topic.scope),
      h("span", "text-[11.5px] text-neutral-500", counts),
    );
    // The facts hang under the topic they belong to, so no topic is listed
    // twice to carry its state.
    if (topic.facts.length === 0) {
      return h("div", "border-b border-neutral-200/70 px-3 py-2.5 last:border-b-0", head);
    }
    const el = document.createElement("details");
    el.className = "border-b border-neutral-200/70 px-3 py-2.5 last:border-b-0";
    el.open = opened.has(id);
    el.ontoggle = () => void (el.open ? opened.add(id) : opened.delete(id));
    const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
    summary.append(h("span", "chev", "▶"), head, h(
      "span",
      "ml-auto flex-none text-[11px] text-neutral-400",
      `${topic.facts.length}${topic.factsMore ? "+" : ""} fact${topic.facts.length === 1 && !topic.factsMore ? "" : "s"}`,
    ));
    const facts = h("div", "mt-2 flex flex-col gap-1 pl-4", ...topic.facts.map(factRow));
    // The cap is stated where it bites, not only in the section note.
    if (topic.factsMore) {
      facts.append(h("p", "pl-2.5 text-[11px] text-neutral-400", "More keys than this page shows — read them with bus get."));
    }
    el.append(summary, facts);
    return el;
  }

  const factRow = (fact: BusFactRow): HTMLElement =>
    h(
      "div",
      "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 border-neutral-200 pl-2.5",
      h("span", "flex-none font-mono text-[11.5px] font-medium text-neutral-700", fact.key),
      mono(fact.payload),
      h("span", "flex-none text-[11px] text-neutral-400", relTime(Date.parse(fact.createdAt))),
      sessionChip(fact.writerSession),
    );

  const subRow = (sub: BusSubRow): HTMLElement =>
    row(
      cell(sessionChip(sub.sessionId)),
      cell(mono(sub.topicGlob)),
      cell(sub.mode),
      cell(h(
        "span",
        sub.lag > 0 ? "text-amber-700" : "text-neutral-500",
        sub.lag === 0 ? "up to date" : `${sub.lag} behind`,
      )),
      cell(h("div", "flex flex-wrap gap-1", ...sub.scopes.map(scopeBadge))),
    );

  function noteRow(note: BusNoteRow): HTMLElement {
    // Seconds, not relTime: the backoff tops out at a minute, and a retry is
    // in the future — relTime only reads backwards.
    const retry = note.nextAttemptAt === null
      ? note.state === "abandoned" ? "given up" : "due now"
      : note.nextAttemptAt > Date.now()
      ? `retry in ${Math.max(1, Math.round((note.nextAttemptAt - Date.now()) / 1000))}s`
      : "retry due";
    return row(
      cell(sessionChip(note.sessionId)),
      cell(mono(note.topicGlob)),
      cell(h("div", "flex flex-wrap items-center gap-1.5", stateBadge(note.state), h(
        "span",
        "text-[11px] text-neutral-500",
        `${note.attempts} attempt${note.attempts === 1 ? "" : "s"} · ${retry}`,
      ))),
      // The reason a delivery is stuck is the whole point of the row.
      cell(h("span", note.state === "abandoned" ? "text-red-600" : "text-neutral-500", note.error ?? "—")),
    );
  }

  function eventRow(event: BusEventRow): HTMLElement {
    const trail = [
      ...(event.causedBy ? [`caused_by ${event.causedBy.slice(-6)}`] : []),
      ...(event.hops ? [`${event.hops} hop${event.hops === 1 ? "" : "s"}`] : []),
      ...(event.filePtr ? [event.filePtr] : []),
    ].join(" · ");
    return row(
      cell(h("span", "text-neutral-500", relTime(Date.parse(event.createdAt)))),
      cell(h(
        "div",
        "flex min-w-0 flex-col gap-1",
        h("span", "truncate", event.topic),
        h("div", "flex flex-wrap gap-1", scopeBadge(event.scope), kindBadge(event.kind)),
      )),
      cell(event.key ? h("span", "break-all font-mono text-[11.5px] text-neutral-700", event.key) : "—"),
      cell(h(
        "div",
        "flex min-w-0 flex-col gap-0.5",
        mono(event.payload),
        // caused_by and hops only when they exist: an empty causal trail is a
        // column of dashes saying nothing.
        ...(trail ? [h("span", "break-all text-[11px] text-neutral-400", trail)] : []),
      )),
      cell(sessionChip(event.writerSession)),
    );
  }

  // --- tab strip, filter, body -------------------------------------------------
  // Built once and never replaced wholesale: retyping in the filter re-renders
  // only the body, so the input keeps focus and the caret keeps its place.

  const tabBtns = h("div", "flex flex-wrap items-center gap-1");
  let typing: ReturnType<typeof setTimeout> | undefined;
  const filter = textInput("", "Search the whole bus…", (v) => {
    query = v.trim();
    // Debounced: this is the only control on the page that costs a database
    // query per keystroke. 250ms is under the threshold where typing stops
    // feeling answered.
    clearTimeout(typing);
    typing = setTimeout(() => void load(), 250);
  });
  const strip = h(
    "div",
    "tabstrip",
    tabBtns,
    h("div", "ml-auto w-64 flex-none max-md:ml-0 max-md:w-full", filter),
  );
  const hint = h("p", "mb-2 mt-3 text-[11.5px] leading-snug text-neutral-500", "");
  const body = h("div", "");

  // Each hint ends by naming what the search reaches on that tab: the same
  // word finds different things per section, and guessing which is not the
  // operator's job.
  const HINTS: Record<Tab, string> = {
    topics: "Per topic and scope: how much history is there, when it last moved, when anyone last read it — and the live facts underneath. Most recently written first; search matches topic and scope, over live and archived rows alike.",
    subs: "Who asked to hear about writes. Lag is counted against the scopes the subscription pinned when it was made; a row lives until its reader unsubscribes or an abandoned delivery retires it. Search matches session, pattern, mode and pinned scope.",
    owed: "Pointer notifications not yet in a recipient's transcript. Abandoned ones are listed first and never truncated away — a delivery nobody can complete is a failure, not an absence. Search matches recipient, pattern, state and reason.",
    events: "The tail of the stream, newest first. Payloads are previews; the full value is one bus get away. Search runs over the whole live table — topic, scope, kind, key, payload, writer — so this is the tab where a *value* is found, tombstones included.",
  };

  function renderTabs(): void {
    const counts: Record<Tab, number> = {
      topics: data.topicsTotal,
      subs: data.subsTotal,
      owed: data.notesTotal,
      events: data.eventsTotal,
    };
    const stuck = data.notes.some((note) => note.state === "abandoned");
    tabBtns.replaceChildren(...TABS.map(([id, label]) => {
      const el = tabButton(`${label} (${counts[id]})`, id === tab, () => onTab(id));
      // A given-up delivery has to be visible from a tab nobody opened —
      // otherwise the tab strip is exactly the place the failure hides.
      if (id === "owed" && stuck) el.classList.add("text-red-600", "font-medium");
      return el;
    }));
  }

  const note = (text: string): HTMLElement => h("p", "mt-2 text-[11.5px] text-neutral-400", text);

  /** The active tab's list, and the two numbers that keep it honest: how many
   *  rows the page holds, and how many exist. */
  function tabBody(): { list: HTMLElement; shown: number; total: number } {
    const nothing = (its: string): HTMLElement =>
      empty(query ? `Nothing in the bus matches “${query}”.` : its);
    if (tab === "topics") {
      return {
        list: data.topics.length
          ? h("div", "rounded-xl border border-neutral-200 bg-white", ...data.topics.map(topicRow))
          : nothing("No events yet. A session's first publish creates its topic."),
        shown: data.topics.length, total: data.topicsTotal,
      };
    }
    if (tab === "subs") {
      return {
        list: data.subs.length
          ? table(
            [["Session", "w-[14%]"], ["Pattern", "w-[26%]"], ["Mode", "w-[10%]"], ["Lag", "w-[14%]"], ["Pinned scopes", ""]],
            data.subs.map(subRow),
          )
          : nothing("Nobody is subscribed."),
        shown: data.subs.length, total: data.subsTotal,
      };
    }
    if (tab === "owed") {
      return {
        list: data.notes.length
          ? table(
            [["Recipient", "w-[14%]"], ["Pattern", "w-[24%]"], ["State", "w-[28%]"], ["Reason", ""]],
            data.notes.map(noteRow),
          )
          : nothing("Nothing owed — every notification landed."),
        shown: data.notes.length, total: data.notesTotal,
      };
    }
    return {
      list: data.events.length
        ? table(
          [["Age", "w-[8%]"], ["Topic", "w-[22%]"], ["Key", "w-[14%]"], ["Payload", ""], ["Writer", "w-[10%]"]],
          data.events.map(eventRow),
        )
        : nothing("The stream is empty."),
      shown: data.events.length, total: data.eventsTotal,
    };
  }

  function renderBody(): void {
    hint.textContent = HINTS[tab];
    const { list, shown, total } = tabBody();
    const lines: HTMLElement[] = [];
    // Never a silent prefix: whatever is hiding rows says so, against the
    // number counted in the database rather than the number that loaded.
    if (shown < total) {
      // A tail is not a truncated list, and calling it capped would invite a
      // paginator the stream does not want.
      lines.push(note(tab === "events"
        ? `The newest ${shown} of ${total} matching events${query ? "" : " — search to reach older ones"}.`
        : `Showing ${shown} of ${total}${query ? " matches" : ""} — this page is capped; narrow the search above.`));
    } else if (query && total > 0) {
      lines.push(note(`${total} match${total === 1 ? "" : "es"} in the whole bus.`));
    }
    body.replaceChildren(list, ...lines);
  }

  // --- render -----------------------------------------------------------------
  // The frame is built once and kept: a live `bus-changed` refetch that
  // replaced the whole page would blur the filter box mid-word and collapse
  // every expanded topic.

  const problemBox = h("p", "mb-3 hidden text-[13px] text-red-600", "");
  const switchBar = h(
    "div",
    "mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-neutral-200 bg-white px-4 py-3",
  );
  const column = h(
    "div",
    "mx-auto flex w-full min-w-0 max-w-5xl flex-col",
    problemBox, switchBar, librarianBar, strip, hint, body,
  );

  function render(): void {
    problemBox.textContent = problem;
    problemBox.classList.toggle("hidden", !problem);
    switchBar.replaceChildren(busSwitch(), switchStatus);
    renderLibrarian();
    if (!data.enabled) {
      // Only the explanation and the switch: the tabs would describe a
      // capability no session can reach. The view itself stays reachable —
      // hiding it would hide the switch with it.
      pane.replaceChildren(h(
        "div",
        "mx-auto flex w-full min-w-0 max-w-5xl flex-col",
        problemBox,
        h(
          "section",
          "rounded-xl border border-neutral-200 bg-white p-4",
          h("h2", "text-[13px] font-semibold text-neutral-700", "The bus is off"),
          h(
            "p",
            "mb-3 mt-0.5 max-w-2xl text-[12.5px] leading-snug text-neutral-500",
            "Shared memory and cross-session events: sessions publish facts, read each other's, "
              + "and subscribe to be notified of writes (docs/bus.md). While it is off the tool is "
              + "not offered to new sessions and owed notifications are frozen — nothing stored is lost.",
          ),
          switchBar,
          // The seed control comes along, disabled and saying why: the one
          // affordance this page offers besides the switch must not simply
          // vanish, or "off" and "gone" read the same.
          librarianBar,
        ),
      ));
      return;
    }
    // Re-seating the same node would still blur what is inside it. The
    // off-state moved problemBox and switchBar into its own tree; coming
    // back, they must be re-seated too or enabling leaves no switch to see.
    if (problemBox.parentElement !== column) column.prepend(problemBox, switchBar, librarianBar);
    if (pane.firstElementChild !== column) pane.replaceChildren(column);
    renderTabs();
    renderBody();
  }

  async function load(): Promise<void> {
    // Every load is stamped and only the newest one may paint: a `bus-changed`
    // refetch, a tab click and a filter keystroke can be in flight together,
    // and the slowest answer is not the truest one — an older response landing
    // last would show rows for a query nobody has typed any more.
    const mine = ++generation;
    const res = await fetch(`/api/bus${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    if (mine !== generation) return;
    if (!res.ok) {
      problem = await failure(res, "Could not load the bus");
      return render();
    }
    const next = (await res.json()) as BusOverview;
    if (mine !== generation) return;
    data = next;
    loaded = true;
    // Cleared before the render, or a recovered fetch keeps showing the old
    // failure until something else repaints.
    problem = "";
    render();
  }

  const view = consoleView(root, (arg) => {
    if (isTab(arg)) tab = arg;
    // Switching tabs repaints from what is already in hand and reconciles from
    // the refetch; a tab that waits on a round trip is a tab that feels slow.
    // Before the first answer there is nothing to claim — least of all "off".
    if (loaded) render();
    else pane.replaceChildren(h("p", "p-4 text-[13px] text-neutral-400", "Loading…"));
    void load();
  });
  return Object.assign(view, {
    refresh() {
      if (view.visible) void load();
    },
  });
}
