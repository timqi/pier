import type { SessionState } from "../../core/types.js";
import type { TaskMessage, TaskRun } from "../../tasks/types.js";
import { h } from "./dom.js";

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

export interface ActivityView {
  show(arg?: string): void;
  hide(): void;
  refresh(): void;
  readonly visible: boolean;
}

const svg = (name: string): SVGElement =>
  document.createElementNS("http://www.w3.org/2000/svg", name);

const elapsed = (since: number | null): string => {
  if (since === null) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export function createActivityView(
  root: HTMLElement,
  openSession: (id: string) => void,
  openTask: (id?: string) => void,
): ActivityView {
  let visible = false;
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

  function control(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn text-[12.5px] ${active ? "bg-neutral-200" : ""}`;
    button.textContent = label;
    button.onclick = onClick;
    return button;
  }

  function render(): void {
    const header = h("header", "flex h-10 flex-none items-center gap-2 border-b border-neutral-200 px-4");
    header.append(h("span", "font-medium", "Activity"));
    const tabs = h("div", "flex items-center gap-1 border-b border-neutral-200 px-4 py-2");
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
      const scopeControl = h("div", "ml-auto flex gap-1");
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
    table.className = "w-full table-fixed text-left text-[12.5px]";
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
      const name = document.createElement("td");
      name.className = "px-4 py-2.5";
      name.append(
        h("div", "truncate font-medium", session.title ?? "Untitled session"),
        h("div", "truncate font-mono text-[11px] text-neutral-400", session.id),
      );
      const project = h("td", "truncate px-2 py-2.5 font-mono text-[11.5px]", session.cwd || "-");
      const state = h("td", "px-2 py-2.5");
      state.append(
        h("span", `mr-2 inline-block h-2 w-2 rounded-full ${session.state === "streaming" ? "animate-pulse bg-green-500" : "bg-neutral-300"}`),
        document.createTextNode(session.state),
      );
      tr.append(name, project, state, h("td", "px-2 py-2.5 text-neutral-500", elapsed(session.stateSince)));
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
    const graph = svg("svg");
    graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
    graph.setAttribute("class", "min-h-[420px] w-full");
    const defs = svg("defs");
    const marker = svg("marker");
    marker.setAttribute("id", "activity-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = svg("path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "#a3a3a3");
    marker.append(arrow);
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
      const line = svg("line");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("stroke", edge.kind === "callback" ? "#0891b2" : edge.kind === "message" ? "#d97706" : "#a3a3a3");
      line.setAttribute("stroke-width", edge.kind === "invocation" ? "1.5" : "2");
      if (edge.kind === "callback") line.setAttribute("stroke-dasharray", "6 5");
      if (edge.kind === "message") line.setAttribute("stroke-dasharray", "2 5");
      line.setAttribute("marker-end", "url(#activity-arrow)");
      line.classList.add("cursor-pointer");
      line.onclick = () => openTask(edge.run.taskId);
      graph.append(line);
    }
    for (const node of all) {
      const p = positions.get(node.id)!;
      const group = svg("g");
      group.setAttribute("transform", `translate(${p.x},${p.y})`);
      if (node.session) group.classList.add("cursor-pointer");
      group.onclick = () => { if (node.session) openSession(node.id); };
      const circle = svg("circle");
      circle.setAttribute("r", "38");
      circle.setAttribute("fill", node.session ? "#ffffff" : "#f5f5f5");
      circle.setAttribute("stroke", node.session ? "#737373" : "#d4d4d4");
      const text = svg("text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("font-size", "11");
      text.setAttribute("fill", "#404040");
      text.textContent = node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label;
      group.append(circle, text);
      graph.append(group);
    }
    const legend = h("div", "flex gap-5 border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-500");
    legend.append(
      h("span", "", "Solid: task invocation"),
      h("span", "text-cyan-700", "Dashed: callback"),
      h("span", "text-amber-700", "Dotted: supervisor/control"),
    );
    body.append(graph, legend);
  }

  return {
    get visible() { return visible; },
    show(arg) {
      visible = true;
      // No arg → reopen on whatever tab was showing when we left.
      if (arg === "dependencies") tab = "dependencies";
      else if (arg === "sessions") { tab = "sessions"; scope = "active"; }
      root.classList.remove("hidden");
      root.classList.add("flex");
      void load();
    },
    hide() { visible = false; root.classList.add("hidden"); root.classList.remove("flex"); },
    refresh() { if (visible) void load(); },
  };
}
