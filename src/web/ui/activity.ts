// Console → Activity: what is happening right now, and what happened in the
// last day — the session table and the directed graph of task runs, drawn from
// one /api/activity snapshot. Its one reason to exist is the picture: which
// run invoked which, which callback went where, and which agent is waiting on
// an answer, none of which any single session's timeline can show.

import { readableTitle } from "../../core/identity.js";
import type { SessionState } from "../../core/types.js";
import type { TaskMessage, TaskRun } from "../../tasks/types.js";
import { coalesce } from "./api.js";
import { consoleView, fmtDuration, h, type ConsoleView } from "./dom.js";
import { tabButton as control } from "./form.js";

interface ActivitySession {
  id: string;
  cwd: string;
  title?: string;
  state: SessionState;
  stateSince: number | null;
}

interface ActivitySnapshot {
  sessions: ActivitySession[];
  runs: TaskRun[];
  messages: TaskMessage[];
}

export type ActivityView = ConsoleView & { refresh(): void };

const svg = (name: string, attrs: Record<string, string> = {}): SVGElement => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const elapsed = (since: number | null): string =>
  since === null ? "-" : fmtDuration(Date.now() - since);

/**
 * The dependency graph is the one surface that cannot inherit the theme.
 * Everywhere else a colour is a Tailwind utility resolving to a CSS variable,
 * which style.css swaps wholesale in dark; here the colours are SVG
 * presentation attributes, and `var()` in one of those is not something every
 * engine resolves. So the graph carries both palettes and picks at draw time —
 * `pier:theme` (theme.ts) is what makes it draw again.
 *
 * Per-kind card chrome; a session's state overrides it (green = streaming,
 * muted = idle) so the graph answers "who is busy" at a glance.
 */
interface Card { fill: string; stroke: string; text: string; dash?: string }
interface Palette {
  edge: string;
  callback: string;
  message: string;
  scheduler: Card;
  console: Card;
  task: Card;
  process: Card;
  streaming: Card;
  idle: Card;
}
const PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    edge: "#a3a3a3",
    callback: "#0891b2",
    message: "#d97706",
    scheduler: { fill: "#f5f3ff", stroke: "#a78bfa", text: "#5b21b6" },
    console: { fill: "#eff6ff", stroke: "#93c5fd", text: "#1d4ed8" },
    task: { fill: "#fffbeb", stroke: "#fbbf24", text: "#92400e" },
    process: { fill: "#f5f5f5", stroke: "#a3a3a3", text: "#525252", dash: "4 3" },
    streaming: { fill: "#ffffff", stroke: "#10b981", text: "#262626" },
    idle: { fill: "#fafafa", stroke: "#d4d4d4", text: "#737373" },
  },
  dark: {
    edge: "#7a7a7a",
    callback: "#3fc3dd",
    message: "#e0a13a",
    scheduler: { fill: "#2b2440", stroke: "#7d63c9", text: "#c9b8f5" },
    console: { fill: "#1f2a3d", stroke: "#4a7fbf", text: "#a8c8f0" },
    task: { fill: "#3a2f1c", stroke: "#b8862a", text: "#f0d49a" },
    process: { fill: "#262626", stroke: "#5c5c5c", text: "#a3a3a3", dash: "4 3" },
    streaming: { fill: "#22302a", stroke: "#10b981", text: "#e5e5e5" },
    idle: { fill: "#212121", stroke: "#4a4a4a", text: "#9a9a9a" },
  },
};
const palette = (): Palette => PALETTE[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];

export function createActivityView(
  root: HTMLElement,
  openSession: (id: string) => void,
  openTask: (id?: string) => void,
): ActivityView {
  let tab: "sessions" | "dependencies" = "sessions";
  let scope: "active" | "recent" = "active";
  let snapshot: ActivitySnapshot = { sessions: [], runs: [], messages: [] };
  /** The last payload drawn, so an event that changed nothing here draws
   *  nothing: a redraw threw away the table's scroll position, and a
   *  replaceChildren() landing between mousedown and mouseup swallows the
   *  click that was already happening. Cleared wherever the pane is emptied. */
  let drawn = "";

  const load = coalesce(async () => {
    const wanted = scope;
    const res = await fetch(`/api/activity?scope=${wanted}`);
    if (!res.ok) {
      drawn = "";
      root.replaceChildren(h("p", "p-4 text-[13px] text-red-600", `Failed to load activity: ${res.status}`));
      return;
    }
    const body = await res.text();
    if (wanted !== scope) return; // stale: the scope changed mid-fetch
    if (body === drawn) return;
    drawn = body;
    const fresh = JSON.parse(body) as ActivitySnapshot;
    // Same speaker-header cleanup the sidebar does (dom.ts): a session titled
    // by an IM prompt must not show a raw platform id here either.
    snapshot = { ...fresh, sessions: fresh.sessions.map((s) => ({ ...s, title: readableTitle(s.title) })) };
    render();
  });

  function render(): void {
    // The mobile top bar already names this view, and this header carries
    // nothing else — below md it would be a duplicate title in its own row.
    const header = h("header", "flex h-10 flex-none items-center gap-2 border-b border-neutral-200 px-4 max-md:hidden", h("span", "font-medium", "Activity"));
    const tabs = h("div", "tabstrip");
    tabs.append(
      control("Sessions", tab === "sessions", () => { tab = "sessions"; render(); }),
      control("Dependencies", tab === "dependencies", () => { tab = "dependencies"; render(); }),
      // Tasks is the sibling console view; the strip just navigates to it.
      control("Tasks", false, () => openTask()),
    );
    // Scope is one filter over one snapshot, so it applies to both tabs and
    // survives switching them — Sessions gets the same 24h history the graph
    // shows. w-full below md forces its own line inside the wrapping .tabstrip.
    const scopeControl = h("div", "ml-auto flex gap-1 max-md:ml-0 max-md:w-full");
    // render() first, load() second: the fetch behind a scope is ~150ms, and
    // until it lands the pressed button would show no sign of having been hit.
    const setScope = (next: typeof scope) => () => {
      scope = next;
      render();
      void load();
    };
    scopeControl.append(
      control("Active", scope === "active", setScope("active")),
      control("Last 24h", scope === "recent", setScope("recent")),
    );
    tabs.append(scopeControl);
    const body = h("div", "min-h-0 flex-1 overflow-auto");
    if (tab === "sessions") renderSessions(body);
    else renderGraph(body);
    root.replaceChildren(header, tabs, body);
  }

  function renderSessions(body: HTMLElement): void {
    const table = document.createElement("table");
    // table-fixed at phone width crushes four columns into each other, so the
    // table keeps its desktop minimum and the pane scrolls sideways instead.
    table.className = "w-full min-w-[38rem] table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="bg-neutral-50 text-[10.5px] uppercase text-neutral-400"><tr>
      <th class="w-[34%] px-4 py-2 font-semibold">Session</th>
      <th class="w-[38%] px-2 py-2 font-semibold">Project</th>
      <th class="w-[14%] px-2 py-2 font-semibold">State</th>
      <th class="px-2 py-2 font-semibold">Duration</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const session of snapshot.sessions) {
      const tr = document.createElement("tr");
      tr.className = "cursor-pointer border-b border-neutral-100 hover:bg-neutral-50";
      tr.onclick = () => openSession(session.id);
      tr.append(
        h("td", "px-4 py-2.5",
          h("div", "truncate font-medium", session.title ?? "Untitled session"),
          h("div", "truncate font-mono text-[11px] text-neutral-400", session.id)),
        h("td", "truncate px-2 py-2.5 font-mono text-[11.5px]", session.cwd || "-"),
        h("td", "px-2 py-2.5",
          h("span", `mr-2 inline-block h-2 w-2 rounded-full ${session.state === "streaming" ? "animate-pulse bg-green-500" : "bg-neutral-300"}`),
          session.state),
        h("td", "px-2 py-2.5 text-neutral-500", elapsed(session.stateSince)),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(table);
    if (!snapshot.sessions.length) body.append(h("p", "p-4 text-[13px] text-neutral-400", scope === "active" ? "No active sessions." : "No sessions in the last 24 hours."));
  }

  function renderGraph(body: HTMLElement): void {
    type NodeKind = "session" | "scheduler" | "task" | "process" | "console";
    interface Node { id: string; label: string; kind: NodeKind; state?: SessionState }
    interface Edge { from: string; to: string; run: TaskRun; kind: "invocation" | "callback" | "message" }
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const add = (id: string, label: string, kind: NodeKind, state?: SessionState): void => {
      if (!nodes.has(id)) nodes.set(id, { id, label, kind, state });
    };
    // Sessions first: they carry the title and state a later add() must not lose.
    for (const session of snapshot.sessions) add(session.id, session.title ?? session.id.slice(0, 10), "session", session.state);
    for (const run of snapshot.runs) {
      const source = run.invokedBySessionId ?? "scheduler";
      const target = run.targetSessionId ?? (run.context.definition.action.type === "bash" ? `process:${run.id}` : `task:${run.id}`);
      add(source, source === "scheduler" ? "Scheduler" : source.slice(0, 10), source === "scheduler" ? "scheduler" : "session");
      add(target, run.targetSessionId ? run.targetSessionId.slice(0, 10) : run.context.definition.action.type === "bash" ? "Bash process" : "Task", run.targetSessionId ? "session" : run.context.definition.action.type === "bash" ? "process" : "task");
      edges.push({ from: source, to: target, run, kind: "invocation" });
      if (run.callbackSessionId) {
        add(run.callbackSessionId, run.callbackSessionId.slice(0, 10), "session");
        edges.push({ from: target, to: run.callbackSessionId, run, kind: "callback" });
      }
    }
    for (const message of snapshot.messages) {
      if (!message.fromSessionId || !message.toSessionId || message.fromSessionId === message.toSessionId) continue;
      const run = snapshot.runs.find((candidate) => candidate.id === message.runId);
      if (!run) continue;
      for (const id of [message.fromSessionId, message.toSessionId]) {
        add(id, id === "console" ? "Console" : id.slice(0, 10), id === "console" ? "console" : "session");
      }
      edges.push({ from: message.fromSessionId, to: message.toSessionId, run, kind: "message" });
    }
    if (!nodes.size) {
      body.append(h("p", "p-4 text-[13px] text-neutral-400", scope === "active" ? "No active dependencies." : "No dependencies in the last 24 hours."));
      return;
    }

    // Layered left→right by BFS depth from the roots (nodes nothing points
    // at), so the graph reads as a flow — who invoked whom — instead of the
    // old circle where every edge crossed the middle.
    const all = [...nodes.values()];
    const incoming = new Set(edges.map((edge) => edge.to));
    const depth = new Map<string, number>();
    const queue = all.filter((node) => !incoming.has(node.id)).map((node) => node.id);
    if (!queue.length) queue.push(all[0]!.id); // pure cycle: pick any root
    for (const id of queue) depth.set(id, 0);
    while (queue.length) {
      const id = queue.shift()!;
      for (const edge of edges) {
        if (edge.from !== id || depth.has(edge.to)) continue;
        depth.set(edge.to, depth.get(id)! + 1);
        queue.push(edge.to);
      }
    }
    for (const node of all) if (!depth.has(node.id)) depth.set(node.id, 0);

    const NODE_W = 180, NODE_H = 46, COL_GAP = 110, ROW_GAP = 30, MARGIN = 28;
    const columns = new Map<number, Node[]>();
    for (const node of all) {
      const col = depth.get(node.id)!;
      columns.set(col, [...(columns.get(col) ?? []), node]);
    }
    const colCount = Math.max(...columns.keys()) + 1;
    const maxRows = Math.max(...[...columns.values()].map((c) => c.length));
    // Same-column edges bow ~35px past the cards' right edge; without this
    // headroom the canvas clips them mid-curve.
    const bowRoom = edges.some((edge) => edge.from !== edge.to && depth.get(edge.from) === depth.get(edge.to)) ? 40 : 0;
    const width = MARGIN * 2 + colCount * NODE_W + (colCount - 1) * COL_GAP + bowRoom;
    const height = MARGIN * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
    const positions = new Map<string, { x: number; y: number }>();
    // Top-aligned rows, not vertically centered columns: a shared top edge
    // reads as a grid, half-row offsets read as clutter.
    for (const [col, colNodes] of columns) {
      colNodes.forEach((node, row) => positions.set(node.id, {
        x: MARGIN + col * (NODE_W + COL_GAP) + NODE_W / 2,
        y: MARGIN + row * (NODE_H + ROW_GAP) + NODE_H / 2,
      }));
    }

    // Real pixel size, not a stretched viewBox: the pane scrolls when the
    // graph outgrows it instead of shrinking labels into illegibility.
    const graph = svg("svg", { width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}`, class: "block" });
    const defs = svg("defs");
    const ink = palette();
    for (const [id, color] of [["activity-arrow", ink.edge], ["activity-arrow-cb", ink.callback], ["activity-arrow-msg", ink.message]] as const) {
      const marker = svg("marker", {
        id,
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "6",
        markerHeight: "6",
        orient: "auto-start-reverse",
      });
      marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
      defs.append(marker);
    }
    graph.append(defs);

    // One drawn edge per (from, to, kind): parallel runs overdraw into fuzz.
    const drawn = new Set<string>();
    for (const edge of edges) {
      const key = `${edge.from}→${edge.to}:${edge.kind}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      // Same column: leave and re-enter on the right, bowing outward — a
      // through curve would cut across the cards in between.
      const d = from.x === to.x
        ? `M ${from.x + NODE_W / 2} ${from.y} C ${from.x + NODE_W / 2 + 46} ${from.y}, ${to.x + NODE_W / 2 + 46} ${to.y}, ${to.x + NODE_W / 2} ${to.y}`
        : (() => {
          const forward = to.x > from.x;
          const x1 = from.x + (forward ? NODE_W / 2 : -NODE_W / 2);
          const x2 = to.x + (forward ? -NODE_W / 2 : NODE_W / 2);
          const bend = Math.max(36, Math.abs(x2 - x1) * 0.45) * (forward ? 1 : -1);
          return `M ${x1} ${from.y} C ${x1 + bend} ${from.y}, ${x2 - bend} ${to.y}, ${x2} ${to.y}`;
        })();
      const path = svg("path", {
        d,
        fill: "none",
        stroke: edge.kind === "callback" ? ink.callback : edge.kind === "message" ? ink.message : ink.edge,
        "stroke-width": "1.5",
        "marker-end": edge.kind === "callback" ? "url(#activity-arrow-cb)" : edge.kind === "message" ? "url(#activity-arrow-msg)" : "url(#activity-arrow)",
      });
      if (edge.kind === "callback") path.setAttribute("stroke-dasharray", "6 5");
      if (edge.kind === "message") path.setAttribute("stroke-dasharray", "2 5");
      path.classList.add("cursor-pointer");
      path.onclick = () => openTask(edge.run.taskId);
      graph.append(path);
    }

    // SVG text doesn't clip to its card, so truncate by width: CJK glyphs run
    // twice as wide as latin at this size.
    const wide = /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
    const fit = (label: string, maxUnits: number): string => {
      let units = 0;
      for (let i = 0; i < label.length; i++) {
        units += wide.test(label[i]!) ? 2 : 1;
        if (units > maxUnits) return `${label.slice(0, i)}…`;
      }
      return label;
    };
    for (const node of all) {
      const p = positions.get(node.id)!;
      const card: Card = node.kind === "session"
        ? node.state === "streaming" ? ink.streaming : ink.idle
        : ink[node.kind];
      const group = svg("g", { transform: `translate(${p.x},${p.y})` });
      if (node.kind === "session") group.classList.add("cursor-pointer");
      group.onclick = () => { if (node.kind === "session") openSession(node.id); };
      const rect = svg("rect", {
        x: String(-NODE_W / 2),
        y: String(-NODE_H / 2),
        width: String(NODE_W),
        height: String(NODE_H),
        rx: "10",
        fill: card.fill,
        stroke: card.stroke,
        "stroke-width": node.kind === "session" && node.state === "streaming" ? "1.5" : "1",
      });
      if (card.dash) rect.setAttribute("stroke-dasharray", card.dash);
      group.append(rect);
      let textX = -NODE_W / 2 + 12;
      if (node.kind === "session") {
        const dot = svg("circle", { cx: String(-NODE_W / 2 + 15), cy: "0", r: "3.5", fill: card.stroke });
        if (node.state === "streaming") {
          const pulse = svg("animate", { attributeName: "opacity", values: "1;0.3;1", dur: "1.6s", repeatCount: "indefinite" });
          dot.append(pulse);
        }
        group.append(dot);
        textX = -NODE_W / 2 + 26;
      }
      const text = svg("text", {
        x: String(textX),
        "text-anchor": "start",
        "dominant-baseline": "middle",
        "font-size": "11.5",
        "font-weight": node.kind === "session" ? "500" : "400",
        fill: card.text,
      });
      text.textContent = fit(node.label, node.kind === "session" ? 22 : 25);
      const title = svg("title");
      title.textContent = node.label === node.id ? node.id : `${node.label}\n${node.id}`;
      group.append(text, title);
      graph.append(group);
    }
    const legendDot = (cls: string): HTMLElement => h("span", `inline-block h-2 w-2 rounded-full ${cls}`);
    body.append(h("div", "w-max p-4", graph), h(
      "div",
      "flex flex-wrap gap-x-5 gap-y-1 border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-500",
      h("span", "", "Solid: task invocation"),
      h("span", "text-cyan-700", "Dashed: callback"),
      h("span", "text-amber-700", "Dotted: supervisor/control"),
      h("span", "inline-flex items-center gap-1.5", legendDot("bg-emerald-500"), "streaming"),
      h("span", "inline-flex items-center gap-1.5", legendDot("bg-neutral-300"), "idle"),
    ));
  }

  const view = consoleView(root, (arg) => {
    // No arg → reopen on whatever tab (and scope) was showing when we left.
    if (arg === "dependencies") tab = "dependencies";
    else if (arg === "sessions") tab = "sessions";
    void load();
  }, () => {
    // Hiding a view only flips a class, so a session table and a graph of every
    // run in the last 24h stay in memory for as long as the page lives — and for
    // nothing: show() re-fetches the snapshot and draws both again.
    root.replaceChildren();
    snapshot = { sessions: [], runs: [], messages: [] };
    drawn = "";
  });
  // The graph's palette is baked into attributes at draw time, so a theme
  // switch under an open graph leaves the old one on screen until it redraws.
  window.addEventListener("pier:theme", () => { if (view.visible) render(); });
  return Object.assign(view, { refresh() { if (view.visible) void load(); } });
}
