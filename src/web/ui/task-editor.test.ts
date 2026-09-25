// Exercise the real editor, form controls and HTTP serialization with a small DOM double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THINKING_LEVELS } from "../../core/types.js";
import { thinkingLabel } from "../../core/reply.js";
import type { TaskDefinition, TaskDraft } from "../../tasks/types.js";
import { openTaskEditor } from "./task-editor.js";
import { installDom, walk, type FakeElement } from "./dom.testkit.js";

let body: FakeElement;
let task: TaskDefinition;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const onSaved = vi.fn();
const deps = { sessions: () => [{ id: "session-a", cwd: "/test" }], tasks: () => [], onSaved };
function control(label: string): FakeElement {
  const field = walk(body).find((el) => el.children[0]?.textContent === label);
  expect(field, label).toBeDefined();
  return field!.children[1]!;
}
async function submit(): Promise<TaskDraft> {
  onSaved.mockClear();
  const form = body.querySelector("form")!;
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
  body = installDom().body;
  task = { id: "task-a", kind: "task", name: "Review", description: "", archived: false, enabled: true,
    trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd: "/test" }, prompt: "Review changes" },
    callback: { type: "none" }, timeoutSeconds: 60, revision: 1, creator: "console", createdBySessionId: null,
    nextRunAt: null, createdAt: 1, updatedAt: 1 };
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
    expect(control("Thinking").children.map((child) => child.textContent)).toEqual(["Project default", ...THINKING_LEVELS.map(thinkingLabel)]);
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
