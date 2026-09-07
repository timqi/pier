// Exercise the real editor, form controls and HTTP serialization with a small DOM double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THINKING_LEVELS } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import type { TaskDefinition, TaskDraft } from "../../tasks/types.js";
import { openTaskEditor } from "./task-editor.js";

class Element {
  children: (Element | string)[] = [];
  classList = { add: vi.fn(), toggle: vi.fn() };
  className = "";
  private selectedValue = "";
  onchange: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  constructor(readonly tag: string) {}
  get value(): string { return this.selectedValue; }
  set value(value: string) {
    // A real select loses its value when no option matches the assignment.
    this.selectedValue = this.tag !== "select" || this.children.some((child) => child instanceof Element && child.value === value) ? value : "";
  }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  addEventListener = vi.fn();
  showModal = vi.fn();
  close = vi.fn();
  focus = vi.fn();
  get text(): string { return this.children.map((child) => typeof child === "string" ? child : child.text).join(""); }
}
class Option extends Element {
  constructor(label: string, value: string) { super("option"); this.append(label); this.value = value; }
}
function walk(el: Element): Element[] {
  return el.children.flatMap((child) => child instanceof Element ? [child, ...walk(child)] : []);
}
let body: Element;
let task: TaskDefinition;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const onSaved = vi.fn();
const deps = { sessions: () => [{ id: "session-a", cwd: "/test" }], tasks: () => [], onSaved };
function control(label: string): Element {
  const field = walk(body).find((el) => el.children[0] instanceof Element && el.children[0].text === label);
  expect(field, label).toBeDefined();
  return field!.children[1] as Element;
}
async function submit(): Promise<TaskDraft> {
  onSaved.mockClear();
  const form = walk(body).find((el) => el.tag === "form")!;
  const preventDefault = vi.fn();
  form.onsubmit!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(task.id));
  const [url, init] = fetcher.mock.lastCall!;
  expect(url).toBe(`/api/tasks/${task.id}`);
  expect(init?.method).toBe("PATCH");
  return JSON.parse(init!.body as string) as TaskDraft;
}
beforeEach(() => {
  body = new Element("body");
  task = { id: "task-a", kind: "task", name: "Review", description: "", archived: false, enabled: true,
    trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd: "/test" }, prompt: "Review changes" },
    callback: { type: "none" }, timeoutSeconds: 60, revision: 1, creator: "console", createdBySessionId: null,
    nextRunAt: null, createdAt: 1, updatedAt: 1 };
  vi.stubGlobal("document", { body, createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("Option", Option);
  fetcher = vi.fn<typeof fetch>(async () => Response.json(task));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("task editor thinking", () => {
  it.each(THINKING_LEVELS)("preserves saved %s through an edit/save/reopen round trip", async (thinking) => {
    if (task.action.type !== "agent") throw new Error("Expected agent fixture");
    task.action.launch = { thinking };
    openTaskEditor(deps, task);
    expect(control("Thinking").value).toBe(thinking);
    expect(control("Thinking").children.map((child) => (child as Element).text)).toEqual(["Project default", ...THINKING_LEVELS.map(thinkingLabel)]);
    const draft = await submit();
    expect(draft.action).toEqual(task.action);
    task = { ...task, ...draft };
    body.replaceChildren();
    openTaskEditor(deps, task);
    expect(control("Thinking").value).toBe(thinking);
    expect((await submit()).action).toEqual(draft.action);
  });

  it.each(THINKING_LEVELS)("saves a newly selected %s override", async (thinking) => {
    openTaskEditor(deps, task);
    control("Thinking").value = thinking;
    expect((await submit()).action).toMatchObject({ launch: { thinking } });
  });

  it.each([false, true])("omits thinking for project default (clear saved override: %s)", async (clear) => {
    if (task.action.type !== "agent") throw new Error("Expected agent fixture");
    if (clear) task.action.launch = { thinking: "max" };
    openTaskEditor(deps, task);
    if (clear) control("Thinking").value = "";
    expect(control("Thinking").value).toBe("");
    const draft = await submit();
    expect(draft.action).toMatchObject({ launch: {} });
    if (draft.action.type !== "agent") throw new Error("Expected agent action");
    expect(draft.action.launch).not.toHaveProperty("thinking");
  });

  it("does not submit launch overrides when switching to reuse", async () => {
    if (task.action.type !== "agent") throw new Error("Expected agent fixture");
    task.action.launch = { thinking: "max", model: { provider: "openai", id: "test-model" } };
    openTaskEditor(deps, task);
    control("Session policy").value = "reuse";
    control("Session policy").onchange!();
    expect((await submit()).action).toEqual({ type: "agent", prompt: "Review changes", session: { mode: "reuse", sessionId: "session-a" } });
  });
});
