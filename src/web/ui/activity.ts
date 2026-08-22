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
      control("Sessions", tab === "sessions", () => {
        tab = "sessions";
        if (scope !== "active") { scope = "active"; void load(); }
        else render();
      }),
      control("Dependencies", tab === "dependencies", () => { tab = "dependencies"; render(); }),
      // Tasks is the sibling console view; the strip just navigates to it.
      control("Tasks", false, () => openTask()),
    );
    if (tab === "dependencies") {
      // w-full below md forces its own line inside the wrapping .tabstrip.
      const scopeControl = h("div", "ml-auto flex gap-1 max-md:ml-0 max-md:w-full");
      scopeControl.append(
        control("Active", scope === "active", () => { scope = "active"; void load(); }),
        control("Last hour", scope === "recent", () => { scope = "recent"; void load(); }),
      );
      tabs.append(scopeControl);
    }
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
    if (!snapshot.sessions.length) body.append(h("p", "p-4 text-[13px] text-neutral-400", "No active sessions."));
  }

  function renderGraph(body: HTMLElement): void {
    interface Node { id: string; label: string; session: boolean }
    interface Edge { from: string; to: string; run: TaskRun; kind: "invocation" | "callback" | "message" }
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const add = (id: string, label: string, session: boolean): void => {
      if (!nodes.has(id)) nodes.set(id, { id, label, session });
    };
    for (const session of snapshot.sessions) add(session.id, session.title ?? session.id.slice(0, 10), true);
    for (const run of snapshot.runs) {
      const source = run.invokedBySessionId ?? "scheduler";
      const target = run.targetSessionId ?? (run.context.definition.action.type === "bash" ? `process:${run.id}` : `task:${run.id}`);
      add(source, source === "scheduler" ? "Scheduler" : source.slice(0, 10), source !== "scheduler");
      add(target, run.targetSessionId ? run.targetSessionId.slice(0, 10) : run.context.definition.action.type === "bash" ? "Bash process" : "Task", run.targetSessionId !== null);
      edges.push({ from: source, to: target, run, kind: "invocation" });
      if (run.callbackSessionId) {
        add(run.callbackSessionId, run.callbackSessionId.slice(0, 10), true);
        edges.push({ from: target, to: run.callbackSessionId, run, kind: "callback" });
      }
    }
    for (const message of snapshot.messages) {
      if (!message.fromSessionId || !message.toSessionId) continue;
      const run = snapshot.runs.find((candidate) => candidate.id === message.runId);
      if (!run) continue;
      add(message.fromSessionId, message.fromSessionId.slice(0, 10), message.fromSessionId !== "console");
      add(message.toSessionId, message.toSessionId.slice(0, 10), message.toSessionId !== "console");
      edges.push({ from: message.fromSessionId, to: message.toSessionId, run, kind: "message" });
    }
    if (!nodes.size) {
      body.append(h("p", "p-4 text-[13px] text-neutral-400", "No active dependencies."));
      return;
    }

    const width = 900;
    const height = Math.max(420, Math.min(680, nodes.size * 90));
    const graph = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "min-h-[26.25rem] w-full" });
    const defs = svg("defs");
    const marker = svg("marker", {
      id: "activity-arrow",
      viewBox: "0 0 10 10",
      refX: "8",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse",
    });
    marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#a3a3a3" }));
    defs.append(marker);
    graph.append(defs);

    const positions = new Map<string, { x: number; y: number }>();
    const all = [...nodes.values()];
    const radius = Math.min(width, height) * 0.34;
    all.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / all.length;
      positions.set(node.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius });
    });
    for (const edge of edges) {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      const line = svg("line", {
        x1: String(from.x),
        y1: String(from.y),
        x2: String(to.x),
        y2: String(to.y),
        stroke: edge.kind === "callback" ? "#0891b2" : edge.kind === "message" ? "#d97706" : "#a3a3a3",
        "stroke-width": edge.kind === "invocation" ? "1.5" : "2",
      });
      if (edge.kind === "callback") line.setAttribute("stroke-dasharray", "6 5");
      if (edge.kind === "message") line.setAttribute("stroke-dasharray", "2 5");
      line.setAttribute("marker-end", "url(#activity-arrow)");
      line.classList.add("cursor-pointer");
      line.onclick = () => openTask(edge.run.taskId);
      graph.append(line);
    }
    for (const node of all) {
      const p = positions.get(node.id)!;
      const group = svg("g", { transform: `translate(${p.x},${p.y})` });
      if (node.session) group.classList.add("cursor-pointer");
      group.onclick = () => { if (node.session) openSession(node.id); };
      const circle = svg("circle", {
        r: "38",
        fill: node.session ? "#ffffff" : "#f5f5f5",
        stroke: node.session ? "#737373" : "#d4d4d4",
      });
      const text = svg("text", {
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": "11",
        fill: "#404040",
      });
      text.textContent = node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label;
      group.append(circle, text);
      graph.append(group);
    }
    body.append(graph, h(
      "div",
      "flex gap-5 border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-500",
      h("span", "", "Solid: task invocation"),
      h("span", "text-cyan-700", "Dashed: callback"),
      h("span", "text-amber-700", "Dotted: supervisor/control"),
    ));
  }

  const view = consoleView(root, (arg) => {
    // No arg → reopen on whatever tab was showing when we left.
    if (arg === "dependencies") tab = "dependencies";
    else if (arg === "sessions") { tab = "sessions"; scope = "active"; }
    void load();
  });
  return Object.assign(view, { refresh() { if (view.visible) void load(); } });
}
