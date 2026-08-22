// Render one Pi provider-owned auth interaction after provider setup starts it.

import type { ProviderAuthEvent, ProviderAuthPrompt, ProviderAuthType } from "../../core/types.js";
import { failure, sendJson } from "./api.js";
import { copyBtn, h } from "./dom.js";
import { button, input, STATUS_TONE, type SaveState } from "./form.js";

type FlowPrompt = ProviderAuthPrompt & { id: string };
export interface AuthFlow {
  id: string;
  providerId: string;
  type: ProviderAuthType;
  state: "running" | "succeeded" | "failed" | "cancelled";
  events: ProviderAuthEvent[];
  prompt?: FlowPrompt;
  error?: string;
}

const safeLink = (raw: string, label: string): HTMLAnchorElement | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const link = h("a", "text-indigo-600 hover:underline", label) as HTMLAnchorElement;
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
};

export function openAuthFlow(
  initial: AuthFlow,
  providerName: string,
  methodName: string,
  onSuccess: () => void,
): void {
  const dialog = document.createElement("dialog");
  dialog.className =
    "m-auto w-[min(32rem,92vw)] rounded-lg border border-neutral-200 bg-white p-0 shadow-xl backdrop:bg-black/30";
  const events = h("div", "flex flex-col gap-2");
  const promptPane = h("div", "flex flex-col gap-2");
  const status = h("p", "text-[12.5px] text-neutral-400", "Starting…");
  const cancel = button("Cancel");
  // One spelling for the status tones — the same table Config/Settings use.
  const setFlowStatus = (state: SaveState, text: string): void => {
    status.className = `text-[12.5px] ${STATUS_TONE[state]}`;
    status.textContent = text;
  };
  dialog.append(
    h("div", "border-b border-neutral-200 px-4 py-2.5 text-[14px] font-semibold", providerName),
    h("div", "flex max-h-[65vh] flex-col gap-3 overflow-y-auto px-4 py-3", events, promptPane, status),
    h("div", "flex justify-end border-t border-neutral-200 px-4 py-2.5", cancel),
  );
  document.body.append(dialog);
  dialog.showModal();

  const flowId = initial.id;
  let flowState: AuthFlow["state"] = initial.state;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentPromptId: string | undefined;
  const answeredPrompts = new Set<string>();
  let closed = false;
  let closing = false;

  const close = async (shouldCancel: boolean): Promise<void> => {
    if (closing) return;
    if (shouldCancel && flowState === "running") {
      closing = true;
      cancel.disabled = true;
      try {
        const res = await sendJson(`/api/providers/flows/${flowId}/cancel`, {});
        // 404 means the server already forgot the flow — nothing left to
        // cancel, so fall through and let the dialog close.
        if (!res.ok && res.status !== 404) {
          setFlowStatus("failed", await failure(res, "Could not cancel authentication flow"));
          return;
        }
      } catch (err) {
        setFlowStatus("failed", `Could not cancel authentication flow: ${String(err)}`);
        return;
      } finally {
        closing = false;
        cancel.disabled = false;
      }
    }
    clearTimeout(timer);
    dialog.close();
  };
  cancel.onclick = () => void close(true);
  dialog.oncancel = (event) => {
    event.preventDefault();
    void close(true);
  };
  dialog.onclose = () => {
    closed = true;
    clearTimeout(timer);
    dialog.remove();
  };

  const renderEvent = (event: ProviderAuthEvent): HTMLElement => {
    if (event.type === "auth_url") {
      const box = h("div", "flex flex-col gap-1 text-[12.5px] text-neutral-600");
      if (event.instructions) box.append(h("p", "", event.instructions));
      box.append(safeLink(event.url, "Open authorization page") ?? h("span", "text-red-600", "Invalid authorization URL"));
      return box;
    }
    if (event.type === "device_code") {
      const box = h("div", "flex flex-col gap-2 text-[12.5px] text-neutral-600");
      box.append(h(
        "div",
        "flex items-center gap-2",
        h("code", "font-mono text-[17px] font-semibold text-neutral-800", event.userCode),
        copyBtn("btn text-[11px]", () => event.userCode),
      ));
      box.append(safeLink(event.verificationUri, "Open verification page") ?? h("span", "text-red-600", "Invalid verification URL"));
      return box;
    }
    const box = h("div", "text-[12.5px] text-neutral-600", event.message);
    if (event.type === "info") {
      for (const item of event.links ?? []) {
        const link = safeLink(item.url, item.label ?? item.url);
        if (link) box.append(" ", link);
      }
    }
    return box;
  };

  const showPrompt = (flow: AuthFlow, prompt: FlowPrompt): void => {
    currentPromptId = prompt.id;
    let control: HTMLInputElement | HTMLSelectElement;
    if (prompt.type === "select") {
      const select = document.createElement("select");
      select.append(...prompt.options.map((option) =>
        new Option(option.description ? `${option.label} — ${option.description}` : option.label, option.id)
      ));
      control = select;
    } else {
      const field = input("", prompt.type === "secret" ? "password" : "text");
      field.placeholder = prompt.placeholder ?? "";
      field.autocomplete = "off";
      control = field;
    }
    control.className =
      `${control.tagName === "SELECT" ? "select " : ""}w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[12.5px] focus:border-indigo-400 focus:outline-none`;
    const submit = button("Continue", true);
    submit.type = "submit";
    const form = h(
      "form", "flex flex-col gap-2",
      h("label", "text-[12.5px] font-medium text-neutral-700", prompt.message),
      control,
      h("div", "flex justify-end", submit),
    ) as HTMLFormElement;
    form.onsubmit = (event) => {
      event.preventDefault();
      submit.disabled = true;
      void (async () => {
        try {
          const res = await sendJson(`/api/providers/flows/${flow.id}/respond`, {
            promptId: prompt.id,
            value: control.value,
          });
          if (closed) return;
          if (!res.ok) {
            setFlowStatus("failed", await failure(res, "Could not submit response"));
            return;
          }
          answeredPrompts.add(prompt.id);
          currentPromptId = undefined;
          promptPane.replaceChildren();
          setFlowStatus("saving", "Waiting for provider…");
        } catch (err) {
          if (!closed) setFlowStatus("failed", `Could not submit response: ${String(err)}`);
        } finally {
          submit.disabled = false;
        }
      })();
    };
    promptPane.replaceChildren(form);
    control.focus();
  };

  const render = (flow: AuthFlow): void => {
    flowState = flow.state;
    events.replaceChildren(...flow.events.map(renderEvent));
    const prompt = flow.prompt && !answeredPrompts.has(flow.prompt.id) ? flow.prompt : undefined;
    if (prompt?.id !== currentPromptId) {
      if (prompt) showPrompt(flow, prompt);
      else {
        currentPromptId = undefined;
        promptPane.replaceChildren();
      }
    }
    if (flow.state === "running") {
      setFlowStatus("saving", prompt ? "Waiting for your response." : "Waiting for provider…");
      return;
    }
    clearTimeout(timer);
    promptPane.replaceChildren();
    if (flow.state === "succeeded") setFlowStatus("saved", `${methodName} configured.`);
    else setFlowStatus("failed", flow.state === "cancelled" ? "Cancelled." : flow.error ?? "Authentication failed.");
    cancel.textContent = "Close";
    cancel.onclick = () => void close(false);
    if (flow.state === "succeeded") onSuccess();
  };

  const poll = async (): Promise<void> => {
    if (closed || flowState !== "running") return;
    try {
      const res = await fetch(`/api/providers/flows/${flowId}`, { cache: "no-store" });
      if (closed) return;
      if (!res.ok) {
        setFlowStatus("failed", await failure(res, "Authentication status unavailable"));
        // 404: the server expired the flow; stop polling and let Close close.
        if (res.status === 404) flowState = "failed";
        else timer = setTimeout(() => void poll(), 1_000);
        return;
      }
      render((await res.json()) as AuthFlow);
      if (flowState === "running") timer = setTimeout(() => void poll(), 500);
    } catch (err) {
      if (closed) return;
      setFlowStatus("failed", `Authentication status unavailable: ${String(err)}`);
      timer = setTimeout(() => void poll(), 1_000);
    }
  };

  render(initial);
  if (flowState === "running") timer = setTimeout(() => void poll(), 500);
}
