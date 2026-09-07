// Settings -> Agent's single-source configuration sync controls.

import type { ConfigSyncStatus } from "../types.js";
import { failure, getJson, sendJson } from "./api.js";
import { copyBtn, h } from "./dom.js";
import { button, field, setStatus, textInput, toggle } from "./form.js";

export function configSyncPane(): { el: HTMLElement; dispose(): void } {
  const el = h("div", "min-h-0 min-w-0 flex-1 overflow-y-auto p-4");
  const body = h("div", "mx-auto flex max-w-3xl min-w-0 flex-col gap-4");
  const notice = h("p", "text-[12px] break-words");
  const sharing = h("section", "flex min-w-0 flex-col gap-3 border-b border-neutral-200 pb-4");
  const subscribing = h("section", "flex min-w-0 flex-col gap-3");
  body.append(h("h2", "text-[14px] font-semibold text-neutral-700", "Configuration sync"), notice, sharing, subscribing);
  el.append(body);
  let state: ConfigSyncStatus | null = null;
  let busy = false;
  let disposed = false;
  let revision = 0;
  let source = "";
  let sourceEdited = false;
  const time = (at: number | null | undefined): string => at ? new Date(at).toLocaleString() : "Never";

  async function load(): Promise<void> {
    const current = revision;
    const got = await getJson<ConfigSyncStatus>("/api/config-sync", "Could not load configuration sync", { cache: "no-store" });
    if (disposed || current !== revision) return;
    if (!got.ok) { setStatus(notice, "failed", got.error); return; }
    state = got.value;
    if (!sourceEdited) source = state.sourceUrl;
    render();
  }

  async function act(action: string): Promise<void> {
    if (busy) return;
    ++revision;
    busy = true; render();
    setStatus(notice, "saving", "Working...");
    try {
      const res = await sendJson("/api/config-sync", { action, ...(action === "subscribe" ? { url: source } : {}) });
      if (!res.ok) throw new Error(await failure(res, "Configuration sync failed"));
      const result = await res.json() as ConfigSyncStatus & { result?: string };
      state = result;
      sourceEdited = false;
      source = result.sourceUrl;
      setStatus(notice, "saved", result.result ?? "Saved");
    } catch (err) {
      setStatus(notice, "failed", err instanceof Error ? err.message : "Configuration sync failed");
      await load();
    } finally { busy = false; if (!disposed) render(); }
  }

  function command(label: string, action: string): HTMLButtonElement {
    const control = button(label);
    control.disabled = busy;
    control.onclick = () => { void act(action); };
    return control;
  }

  function render(): void {
    if (!state || disposed) return;
    sharing.replaceChildren(h("h3", "text-[13px] font-medium text-neutral-700", "Publish"));
    if (state.publishedPath) {
      const url = `${state.publicUrl || window.location.origin}${state.publishedPath}`;
      const link = textInput(url, "", () => {}, true);
      link.readOnly = true;
      link.setAttribute("aria-label", "Sharing URL");
      sharing.append(link, h("div", "flex flex-wrap items-center gap-2",
        copyBtn("btn text-[12px]", () => url), command("Revoke link", "revoke")));
    } else sharing.append(h("div", "", command("Generate link", "publish")));
    sharing.append(h("p", "text-[12px] text-neutral-500", "Anyone with the link can read shared prompts. Provider connections and credentials stay private."));

    const urlInput = textInput(source, "https://example.com/config-sync/...", (value) => {
      source = value; sourceEdited = true;
    }, true);
    urlInput.type = "url";
    urlInput.setAttribute("aria-label", "Configuration source URL");
    urlInput.disabled = busy || state.enabled;
    const enabled = toggle("Automatic sync", "", state.enabled, (on) => { void act(on ? "subscribe" : "pause"); });
    enabled.querySelector("input")!.disabled = busy;
    const actions = h("div", "flex flex-wrap items-center gap-3", enabled);
    if (state.enabled) actions.append(command("Sync now", "sync"));
    subscribing.replaceChildren(h("h3", "text-[13px] font-medium text-neutral-700", "Source"), field("Source URL", urlInput), actions);
    const status = h("dl", "grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]");
    for (const [label, value] of [
      ["Last checked", time(state.lastChecked)], ["Last applied", time(state.lastApplied)],
      ["Next check", state.enabled ? time(state.nextRunAt) : "Paused"],
    ] as const) status.append(h("dt", "text-neutral-500", label), h("dd", "min-w-0 break-words text-neutral-700", value));
    subscribing.append(status);
    if (state.error) subscribing.append(h("p", "text-[12px] break-words text-red-600", state.error));
    if (state.needsReload) subscribing.append(h("p", "text-[12px] text-amber-700", "Reload pending; retry synchronization."));
    if (state.taskId) {
      const runs = h("a", "text-[12px] text-indigo-600 hover:underline", "Sync task history") as HTMLAnchorElement;
      runs.href = `#/tasks/${encodeURIComponent(state.taskId)}`;
      subscribing.append(runs);
    }
  }

  void load();
  const timer = setInterval(() => { if (!busy && !sourceEdited) void load(); }, 15_000);
  return { el, dispose: () => { disposed = true; clearInterval(timer); } };
}
