// Console → Activity: the session table and the directed graph of task runs,
// from one /api/activity snapshot — the picture no single session's timeline can show.

import { List, Waypoints } from "lucide";
import { readableTitle } from "../../core/identity.js";
import type { SessionState } from "../../core/types.js";
import type { TaskMessage, TaskRun } from "../../tasks/types.js";
import { coalesce, getJson } from "./api.js";
import { consoleView, fmtDuration, h, untitled, type ConsoleView } from "./dom.js";
import { badge, empty, segmented, toolbar } from "./form.js";
import { closeMenu } from "./menu.js";
import { sessionInfo } from "./session-header.js";

interface ActivitySession {
  id: string;
  cwd: string;
  /** Null for a session the listing no longer has: the graph knows only its id. */
  createdAt: number | null;
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

/** Edges are the graph's only SVG, and they take their colour as utility
 *  classes, so a theme switch recolours a drawn graph like any other surface. */
const EDGE: Record<"invocation" | "callback" | "message", { stroke: string; fill: string; dash?: string }> = {
  invocation: { stroke: "stroke-neutral-400", fill: "fill-neutral-400" },
  callback: { stroke: "stroke-cyan-500", fill: "fill-cyan-500", dash: "6 5" },
  message: { stroke: "stroke-amber-500", fill: "fill-amber-500", dash: "2 5" },
};
/** The badge tones the Console already uses for the same actors: violet is
 *  `agent` on Tasks, indigo the selection tint, amber the run-in-flight chip. */
const NODE_TONE = {
  scheduler: "border-violet-200 bg-violet-50 text-violet-700",
  console: "border-indigo-200 bg-indigo-50 text-indigo-700",
  task: "border-amber-200 bg-amber-50 text-amber-700",
  process: "border-dashed border-neutral-300 bg-neutral-50 text-neutral-500",
  streaming: "border-emerald-200 bg-white font-medium text-neutral-800",
  idle: "border-neutral-200 bg-white font-medium text-neutral-600",
};
const HOVER_DELAY = 300;
const SLOP = 4; // a click from a shaky hand is still a click

/** A rested pointer opens the session's info panel under its card; leaving
 *  both the card and the panel closes it. A finger never rests, so touch gets
 *  nothing and the tap stays the click that opens the chat. */
function hoverInfo(card: HTMLElement, session: Parameters<typeof sessionInfo>[1]): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let panel: HTMLElement | null = null;
  let overCard = false;
  let overPanel = false;
  const settle = (): void => {
    clearTimeout(timer);
    // Grace for the 4px gap between card and panel; a redraw's stale card is
    // not ours to close (`data-closing` marks a panel already on its way out).
    timer = setTimeout(() => {
      if (overCard || overPanel || !panel || panel.dataset.closing !== undefined) return;
      closeMenu();
      panel = null;
    }, 120);
  };
  card.onpointerenter = (ev) => {
    if (ev.pointerType === "touch") return;
    overCard = true;
    clearTimeout(timer);
    if (panel?.isConnected && panel.dataset.closing === undefined) return;
    timer = setTimeout(() => {
      if (!card.isConnected || !overCard) return;
      panel = sessionInfo(card, session);
      panel.onpointerenter = () => { overPanel = true; clearTimeout(timer); };
      panel.onpointerleave = () => { overPanel = false; settle(); };
    }, HOVER_DELAY);
  };
  card.onpointerleave = () => { overCard = false; settle(); };
  // A press is a click coming: the panel would open under it and eat the chat.
  card.onpointerdown = () => clearTimeout(timer);
}

/** Mouse and pen pan the pane by dragging its empty canvas; a finger already
 *  scrolls it natively. Nodes and edges keep their clicks, and a drag longer
 *  than the slop swallows the click it would otherwise end in. */
function panWith(pane: HTMLElement): void {
  let from: { x: number; y: number; left: number; top: number } | undefined;
  let panned = false;
  pane.classList.add("cursor-grab");
  pane.onpointerdown = (ev) => {
    panned = false;
    if (ev.button !== 0 || ev.pointerType === "touch" || (ev.target as Element).closest("[data-node], path")) return;
    from = { x: ev.clientX, y: ev.clientY, left: pane.scrollLeft, top: pane.scrollTop };
    pane.setPointerCapture(ev.pointerId);
    pane.classList.add("cursor-grabbing", "select-none");
  };
  pane.onpointermove = (ev) => {
    if (!from) return;
    const dx = ev.clientX - from.x;
    const dy = ev.clientY - from.y;
    if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) panned = true;
    pane.scrollLeft = from.left - dx;
    pane.scrollTop = from.top - dy;
  };
  const end = (): void => {
    from = undefined;
    pane.classList.remove("cursor-grabbing", "select-none");
  };
  pane.onpointerup = end;
  pane.onpointercancel = end;
  pane.addEventListener("click", (ev) => {
    if (!panned) return;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
}

export function createActivityView(
  root: HTMLElement,
  openSession: (id: string) => void,
  openRun: (id: string) => void,
): ActivityView {
  let tab: "sessions" | "dependencies" = "sessions";
  let scope: "active" | "recent" = "active";
  let snapshot: ActivitySnapshot = { sessions: [], runs: [], messages: [] };
  /** A redraw throws away the scroll position, and one landing between
   *  mousedown and mouseup swallows the click. */
  let drawn = "";

  const load = coalesce(async () => {
    const wanted = scope;
    const got = await getJson<ActivitySnapshot>(`/api/activity?scope=${wanted}`, "Failed to load activity");
    if (!got.ok) {
      drawn = "";
      root.replaceChildren(h("p", "p-4 text-[13px] text-red-600", got.error));
      return;
    }
    if (wanted !== scope) return; // stale: the scope changed mid-fetch
    const body = JSON.stringify(got.value);
    if (`${wanted}:${body}` === drawn) return;
    drawn = `${wanted}:${body}`;
    const fresh = got.value;
    // Same speaker-header cleanup the sidebar does (dom.ts): a session titled
    // by an IM prompt must not show a raw platform id here either.
    snapshot = { ...fresh, sessions: fresh.sessions.map((s) => ({ ...s, title: readableTitle(s.title) })) };
    render();
  });

  function render(): void {
    // One toolbar under the Automation strip: which picture on the left, the
    // time scope it covers on the right. The strip names the view, so no title.
    const bar = toolbar(

      segmented<typeof tab>([["Sessions", "sessions", List], ["Relationships", "dependencies", Waypoints]], tab, (next) => { tab = next; render(); }),
      h("span", "ml-auto text-[11.5px] text-neutral-400", `${snapshot.sessions.length} sessions · ${snapshot.runs.length} runs`),
      // render() first, load() second: the fetch behind a scope is ~150ms, and
      // until it lands the pressed button would show no sign of having been hit.
      segmented<typeof scope>([["Current", "active"], ["Last 24h", "recent"]], scope, (next) => {
        scope = next;
        render();
        void load();
      }),
    );
    const body = h("div", "automation-list min-h-0 flex-1 overflow-auto");
    if (tab === "sessions") renderSessions(body);
    else renderGraph(body);
    root.replaceChildren(bar, body);
  }

  function renderSessions(body: HTMLElement): void {
    const table = document.createElement("table");
    table.className = "w-full table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="sticky top-0 bg-neutral-50 text-[10.5px] uppercase tracking-wide text-neutral-400 shadow-[inset_0_-1px_0_var(--color-neutral-200)]"><tr>
      <th class="w-[50%] px-4 py-2 font-semibold md:w-[34%]">Session</th>
      <th class="hidden w-[38%] px-2 py-2 font-semibold md:table-cell">Project</th>
      <th class="px-2 py-2 font-semibold md:w-[14%]">State</th>
      <th class="px-2 py-2 font-semibold">In state</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const session of snapshot.sessions) {
      const tr = document.createElement("tr");
      tr.className = "cursor-pointer border-b border-neutral-100 transition-colors hover:bg-neutral-50";
      tr.onclick = () => openSession(session.id);
      const title = h("button", "block w-full cursor-pointer truncate text-left font-medium text-neutral-800", session.title ?? untitled(session.cwd));
      title.setAttribute("type", "button");
      title.title = `${session.id}\n${session.cwd}`;
      title.onclick = (event) => { event.stopPropagation(); openSession(session.id); };
      tr.append(
        h("td", "px-4 py-2.5", title,
          h("div", "truncate font-mono text-[11px] text-neutral-400 md:hidden", session.cwd || "-")),
        h("td", "hidden truncate px-2 py-2.5 font-mono text-[11.5px] text-neutral-500 md:table-cell", session.cwd || "-"),
        h("td", "px-2 py-2.5", stateBadge(session.state)),
        h("td", "px-2 py-2.5 font-mono text-[11.5px] text-neutral-400", elapsed(session.stateSince)),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(table);
    if (!snapshot.sessions.length) body.append(h("div", "p-4", empty(scope === "active" ? "No active sessions." : "No sessions in the last 24 hours.")));
  }

  /** Streaming is the one state that is happening; every other reads as rest. */
  function stateBadge(state: SessionState): HTMLElement {
    return state === "streaming"
      ? badge(state, "bg-emerald-50 text-emerald-700 ring-emerald-200", "animate-pulse bg-emerald-500")
      : badge(state, "bg-neutral-100 text-neutral-600 ring-neutral-200", "bg-neutral-300");
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
      body.append(h("div", "p-4", empty(scope === "active" ? "No active dependencies." : "No dependencies in the last 24 hours.")));
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
    // graph outgrows it instead of shrinking labels into illegibility. Edges
    // are SVG; nodes are HTML cards over it, so text truncates and colours
    // theme like everywhere else.
    const stage = h("div", "relative");
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    const graph = svg("svg", { width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}`, class: "absolute inset-0" });
    const defs = svg("defs");
    for (const [kind, tone] of Object.entries(EDGE)) {
      const marker = svg("marker", {
        id: `activity-arrow-${kind}`,
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "6",
        markerHeight: "6",
        orient: "auto-start-reverse",
      });
      marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: tone.fill }));
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
      const tone = EDGE[edge.kind];
      const path = svg("path", {
        d,
        fill: "none",
        class: `cursor-pointer ${tone.stroke}`,
        "stroke-width": "1.5",
        "marker-end": `url(#activity-arrow-${edge.kind})`,
      });
      if (tone.dash) path.setAttribute("stroke-dasharray", tone.dash);
      path.onclick = () => openRun(edge.run.id);
      graph.append(path);
    }
    stage.append(graph);

    for (const node of all) {
      const p = positions.get(node.id)!;
      const tone = node.kind === "session" ? (node.state === "streaming" ? NODE_TONE.streaming : NODE_TONE.idle) : NODE_TONE[node.kind];
      const card = h(
        node.kind === "session" ? "button" : "div",
        `absolute flex items-center gap-2 rounded-xl border px-3 text-left text-[11.5px] shadow-xs ${tone} ${node.kind === "session" ? "cursor-pointer hover:bg-neutral-50" : "cursor-default"}`,
        ...(node.kind === "session" ? [h("span", `inline-block h-1.5 w-1.5 flex-none rounded-full ${node.state === "streaming" ? "animate-pulse bg-emerald-500" : "bg-neutral-300"}`)] : []),
        h("span", "min-w-0 truncate", node.label),
      );
      card.dataset.node = node.id;
      card.style.left = `${p.x - NODE_W / 2}px`;
      card.style.top = `${p.y - NODE_H / 2}px`;
      card.style.width = `${NODE_W}px`;
      card.style.height = `${NODE_H}px`;
      card.title = node.label === node.id ? node.id : `${node.label}\n${node.id}`;
      if (node.kind === "session") {
        card.setAttribute("type", "button");
        card.onclick = () => openSession(node.id);
        const session = snapshot.sessions.find((candidate) => candidate.id === node.id);
        if (session?.createdAt !== null && session?.createdAt !== undefined) hoverInfo(card, { ...session, createdAt: session.createdAt });
      }
      stage.append(card);
    }
    panWith(body);
    const legendDot = (cls: string): HTMLElement => h("span", `inline-block h-2 w-2 rounded-full ${cls}`);
    // Line samples drawn the way the edges are, so the legend is read, not decoded.
    const legendLine = (cls: string): HTMLElement => h("span", `inline-block h-0 w-6 border-t-2 ${cls}`);
    body.append(h("div", "w-max p-4", stage), h(
      "div",
      "flex flex-wrap gap-x-5 gap-y-1.5 border-t border-neutral-200 bg-neutral-50/60 px-4 py-2 text-[11px] text-neutral-500",
      h("span", "inline-flex items-center gap-2", legendLine("border-solid border-neutral-400"), "task invocation"),
      h("span", "inline-flex items-center gap-2 text-cyan-700", legendLine("border-dashed border-cyan-500"), "callback"),
      h("span", "inline-flex items-center gap-2 text-amber-700", legendLine("border-dotted border-amber-500"), "control message"),
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
  return Object.assign(view, { refresh() { if (view.visible) void load(); } });
}
