import type { SessionState } from "../../core/types.js";
import type { TaskMessage, TaskRun } from "../../tasks/types.js";
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

export function createActivityView(
  root: HTMLElement,
  openSession: (id: string) => void,
  openTask: (id?: string) => void,
): ActivityView {
  let tab: "sessions" | "dependencies" = "sessions";
  let scope: "active" | "recent" = "active";
  let snapshot: ActivitySnapshot = { sessions: [], runs: [], messages: [] };

  async function load(): Promise<void> {
    const res = await fetch(`/api/activity?scope=${scope}`);
    if (!res.ok) {
      root.replaceChildren(h("p", "p-4 text-[13px] text-red-600", `Failed to load activity: ${res.status}`));
      return;
    }
    snapshot = (await res.json()) as ActivitySnapshot;
    render();
  }

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
    scopeControl.append(
      control("Active", scope === "active", () => { scope = "active"; void load(); }),
      control("Last 24h", scope === "recent", () => { scope = "recent"; void load(); }),
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
    const width = MARGIN * 2 + colCount * NODE_W + (colCount - 1) * COL_GAP;
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
    for (const [id, color] of [["activity-arrow", "#a3a3a3"], ["activity-arrow-cb", "#0891b2"], ["activity-arrow-msg", "#d97706"]] as const) {
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
        stroke: edge.kind === "callback" ? "#0891b2" : edge.kind === "message" ? "#d97706" : "#a3a3a3",
        "stroke-width": "1.5",
        "marker-end": edge.kind === "callback" ? "url(#activity-arrow-cb)" : edge.kind === "message" ? "url(#activity-arrow-msg)" : "url(#activity-arrow)",
      });
      if (edge.kind === "callback") path.setAttribute("stroke-dasharray", "6 5");
      if (edge.kind === "message") path.setAttribute("stroke-dasharray", "2 5");
      path.classList.add("cursor-pointer");
      path.onclick = () => openTask(edge.run.taskId);
      graph.append(path);
    }

    // Per-kind card chrome; a session's state overrides it (green = streaming,
    // muted = idle) so the graph answers "who is busy" at a glance.
    const CARD: Record<Exclude<NodeKind, "session">, { fill: string; stroke: string; text: string; dash?: string }> = {
      scheduler: { fill: "#f5f3ff", stroke: "#a78bfa", text: "#5b21b6" },
      console: { fill: "#eff6ff", stroke: "#93c5fd", text: "#1d4ed8" },
      task: { fill: "#fffbeb", stroke: "#fbbf24", text: "#92400e" },
      process: { fill: "#f5f5f5", stroke: "#a3a3a3", text: "#525252", dash: "4 3" },
    };
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
      const card = node.kind === "session"
        ? node.state === "streaming"
          ? { fill: "#ffffff", stroke: "#10b981", text: "#262626" }
          : { fill: "#fafafa", stroke: "#d4d4d4", text: "#737373" }
        : CARD[node.kind];
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
        const dot = svg("circle", { cx: String(-NODE_W / 2 + 15), cy: "0", r: "3.5", fill: node.state === "streaming" ? "#10b981" : "#d4d4d4" });
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
  });
  return Object.assign(view, { refresh() { if (view.visible) void load(); } });
}
