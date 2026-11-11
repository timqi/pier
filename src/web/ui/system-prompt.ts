// The System prompt dialog (⋯ menu): read-only, the prompt a session's model
// has as its transcript holds it, one block per source under a row naming
// each, copyable whole.

import { X } from "lucide";
import { icon } from "./icons.js";
import { mustGetJson } from "./api.js";
import { compact } from "../../core/reply.js";
import { copyBtn, h, untitled } from "./dom.js";
import type { SystemPrompt } from "../../core/types.js";

const TOC = "min-h-11 sm:min-h-7 shrink-0 cursor-pointer whitespace-nowrap rounded-md px-2 text-[13px] text-neutral-700 hover:bg-neutral-100 focus-visible:outline-2";
const COPY = "min-h-11 min-w-11 sm:min-h-8 shrink-0 cursor-pointer rounded-lg px-2 py-1 text-[13px] font-sans text-neutral-500 hover:bg-neutral-100 focus-visible:outline-2 disabled:cursor-default disabled:opacity-50";

/** Same estimate the server's total is (characters / 4), for a block's share. */
const approx = (text: string): string => `~${compact(Math.ceil(text.length / 4)).toLowerCase()}`;
const estimate = (text: string): string => `${approx(text)} tokens`;

/** `agent/` knows no chain, so the charter is named by where it lives: under `chains/<id>/`,
 *  and not the session's directory or one above it, whose `AGENTS.md` is a project's. */
const labelOf = (block: SystemPrompt["blocks"][number], cwd: string): string => {
  const dir = /^(.*\/chains\/[^/]+)\/AGENTS\.md$/.exec(block.path ?? "")?.[1];
  return dir !== undefined && !`${cwd}/`.startsWith(`${dir}/`) ? "Chain charter" : block.label;
};

/** The reading modal, full-screen within the safe area below md; the Charter dialog wears it too. */
export const MODAL = "m-auto h-[calc(100dvh-4rem)] max-h-none w-[48rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[10px] border border-(--line) bg-white p-0 font-sans shadow-(--shadow-pop) open:flex max-md:m-0 max-md:h-dvh max-md:w-full max-md:max-w-none max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]";

export function openSystemPrompt(s: { id: string; title?: string; cwd: string }): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "System prompt");
  dialog.className = MODAL;
  let text = "";
  const copy = copyBtn(COPY, () => text);
  copy.setAttribute("aria-label", "Copy system prompt");
  (copy as HTMLButtonElement).disabled = true;
  const close = h("button", "icon-btn h-11 w-11 sm:h-8 sm:w-8", icon(X));
  close.setAttribute("aria-label", "Close system prompt");
  close.onclick = () => dialog.close();
  const total = h("div", "mt-0.5 text-[13px] text-neutral-500", "Loading…");
  // Wraps on a wide screen; on a phone the row scrolls sideways instead of
  // pushing the blocks down.
  const toc = h("nav", "-mx-2 mt-1.5 flex gap-1 empty:hidden max-md:overflow-x-auto md:flex-wrap");
  toc.setAttribute("aria-label", "Blocks");
  const body = h("div", "min-h-0 flex-1 overflow-y-auto px-4 py-3");
  dialog.append(
    h("div", "flex items-start gap-2 border-b border-neutral-200 px-4 py-3",
      h("div", "min-w-0 flex-1",
        h("div", "text-sm font-medium text-neutral-500", "System prompt"),
        h("h2", "mt-1 [overflow-wrap:anywhere] text-lg leading-7 font-semibold text-neutral-900", s.title ?? untitled(s.cwd)),
        total, toc),
      copy, close),
    body,
  );
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  void mustGetJson<SystemPrompt>(`/api/sessions/${s.id}/system-prompt`, "Could not load the system prompt").then((prompt) => {
    text = prompt.text;
    (copy as HTMLButtonElement).disabled = false;
    total.textContent = `~${compact(prompt.tokens).toLowerCase()} tokens · ${prompt.blocks.length} blocks · as the transcript holds it`;
    const sections = prompt.blocks.map((block) =>
      h("section", "mb-4 last:mb-0",
        h("div", "mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5",
          h("h3", "text-[15px] font-medium text-neutral-900", labelOf(block, s.cwd)),
          ...(block.path ? [h("span", "min-w-0 [overflow-wrap:anywhere] font-mono text-[13px] text-neutral-500", block.path)] : []),
          h("span", "ml-auto text-[13px] text-neutral-500", estimate(block.text))),
        h("pre", "whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl bg-neutral-50 px-3 py-2.5 font-mono text-[13px] leading-5 text-neutral-800", block.text)));
    toc.replaceChildren(...prompt.blocks.map((block, i) => {
      // The space keeps the accessible name two words: `Skills ~512`.
      const jump = h("button", TOC, `${labelOf(block, s.cwd)} `, h("span", "ml-0.5 text-neutral-500", approx(block.text)));
      jump.onclick = () => sections[i]!.scrollIntoView({ block: "start" });
      return jump;
    }));
    body.replaceChildren(...sections);
  }, (err: unknown) => {
    total.textContent = err instanceof Error ? err.message : String(err);
    total.className = "mt-0.5 text-[13px] text-red-700";
    total.setAttribute("role", "alert");
  });
  return dialog;
}
