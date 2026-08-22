// Console → Settings view: the two things about this Pier instance a human
// owns and nothing else can derive — the password in front of every HTTP
// surface, and the URL the instance is reached at from outside. Neither belongs
// to a session, a channel or a board, which is why they are not in those views.

import { failure, sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { button, card, field, input, setStatus } from "./form.js";

export function createSettingsView(root: HTMLElement): ConsoleView {
  const header = h(
    "header",
    "flex h-10 flex-none items-center gap-3 border-b border-neutral-200 px-4 max-md:hidden",
    h("span", "font-medium", "Settings"),
  );
  const column = h("div", "mx-auto flex max-w-2xl flex-col gap-6");
  const pane = h("div", "px-4 py-5", column);
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, pane));

  // --- public URL ---------------------------------------------------------------

  const urlInput = input();
  urlInput.placeholder = "https://pier.example.com";
  urlInput.autocomplete = "off";
  const urlStatus = h("span", "text-[11.5px]", "");
  const urlSave = button("Save", true);

  async function saveUrl(): Promise<void> {
    setStatus(urlStatus, "saving", "saving…");
    const res = await sendJson("/api/settings", { publicUrl: urlInput.value }, "PUT");
    if (!res.ok) return setStatus(urlStatus, "failed", await failure(res, "Could not save"));
    const { publicUrl } = (await res.json()) as { publicUrl: string };
    urlInput.value = publicUrl;
    setStatus(
      urlStatus,
      "saved",
      publicUrl ? `Saved — boards link as ${publicUrl}/p/<slug>/` : "Cleared.",
    );
  }
  urlSave.onclick = () => void saveUrl();
  urlInput.onkeydown = (ev) => {
    if (ev.key === "Enter") void saveUrl();
  };

  const urlCard = card(
    "Public URL",
    "Where this Pier is reached from outside — the proxy's address, not the port it listens on.",
    field("Base URL", urlInput, {
      hint:
        "Agents read it to hand you a clickable board link instead of a path. " +
        "Nothing here changes what Pier serves; leave it empty if Pier is only reachable locally.",
    }),
    h("div", "flex items-center gap-3", urlSave, urlStatus),
  );

  // --- password -----------------------------------------------------------------

  const current = input("", "password");
  const next = input("", "password");
  const confirm = input("", "password");
  for (const el of [current, next, confirm]) el.autocomplete = "off";
  const pwStatus = h("span", "text-[11.5px]", "");
  const pwSave = button("Change password", true);

  async function savePassword(): Promise<void> {
    // Checked here because only this side knows what was typed twice; length
    // and the current password are the server's call.
    if (next.value !== confirm.value) {
      return setStatus(pwStatus, "failed", "The two new passwords differ.");
    }
    setStatus(pwStatus, "saving", "changing…");
    const res = await sendJson("/api/password", { current: current.value, next: next.value });
    if (!res.ok) {
      return setStatus(pwStatus, "failed", await failure(res, "Could not change the password"));
    }
    for (const el of [current, next, confirm]) el.value = "";
    setStatus(pwStatus, "saved", "Changed. Every other signed-in browser has to sign in again.");
  }
  pwSave.onclick = () => void savePassword();
  confirm.onkeydown = (ev) => {
    if (ev.key === "Enter") void savePassword();
  };

  const pwCard = card(
    "Password",
    "One shared password guards every page and API route. Changing it signs out every other browser.",
    field("Current password", current),
    field("New password", next, { hint: "At least 10 characters." }),
    field("Repeat new password", confirm),
    h("div", "flex items-center gap-3", pwSave, pwStatus),
  );

  column.append(urlCard, pwCard);

  return consoleView(root, () => {
    pwStatus.textContent = "";
    void (async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return setStatus(urlStatus, "failed", await failure(res, "Could not load settings"));
      urlInput.value = ((await res.json()) as { publicUrl: string }).publicUrl;
      urlStatus.textContent = "";
    })();
  });
}
