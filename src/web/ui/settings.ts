// Console → Settings view: the instance-level facts a human owns and nothing
// else can derive, one tab per topic. "Instance" holds the password in front
// of every HTTP surface and the URL the instance is reached at from outside;
// "Security" holds the master key that seals every stored credential. A pure
// consumer of /api/settings, /api/password and /api/secrets.

import { failure, sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { badge, btn, button, card, empty, field, input, setStatus } from "./form.js";

type Topic = "instance" | "security";
const TOPICS: [Topic, string][] = [["instance", "Instance"], ["security", "Security"]];

/** What /api/secrets answers — never key material. */
interface SecretsStatus {
  state: "locked" | "unlocked";
  mode: "vt" | "file" | null;
  reason?: string;
}

export function createSettingsView(root: HTMLElement): ConsoleView {
  let topic: Topic = "instance";

  // Same sticky pattern as Channels: header and tabs are sticky rows inside
  // the scroll container, so a page long enough to scroll still names the
  // topic being edited. top-10 == the header's h-10, so the two rows stack.
  const header = h(
    "header",
    "sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-neutral-200 bg-white px-4",
    h("span", "font-medium max-md:hidden", "Settings"),
  );
  const tabs = h("div", "sticky top-10 z-30 flex items-center gap-1 border-b border-neutral-200 bg-white px-4 py-2");
  const pane = h("div", "px-4 py-5");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, tabs, pane));

  function renderTabs(): void {
    tabs.replaceChildren(
      ...TOPICS.map(([id, label]) => {
        const active = id === topic;
        const tab = btn(
          label,
          `cursor-pointer rounded-md px-2.5 py-1 text-[13px] transition-colors ${
            active ? "bg-indigo-50 font-medium text-indigo-700" : "text-neutral-600 hover:bg-neutral-100"
          }`,
        );
        tab.onclick = () => {
          topic = id;
          show();
        };
        return tab;
      }),
    );
  }

  // --- Instance: public URL ------------------------------------------------------

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

  // --- Instance: password ----------------------------------------------------------

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

  const instanceColumn = h("div", "mx-auto flex max-w-2xl flex-col gap-6", urlCard, pwCard);

  function loadInstance(): void {
    pwStatus.textContent = "";
    void (async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return setStatus(urlStatus, "failed", await failure(res, "Could not load settings"));
      urlInput.value = ((await res.json()) as { publicUrl: string }).publicUrl;
      urlStatus.textContent = "";
    })();
  }

  // --- Security: master key --------------------------------------------------------

  const securityColumn = h("div", "mx-auto flex max-w-2xl flex-col gap-6");

  async function loadSecurity(): Promise<void> {
    const res = await fetch("/api/secrets");
    if (!res.ok) {
      securityColumn.replaceChildren(empty(await failure(res, "Could not load key status")));
      return;
    }
    renderSecurity((await res.json()) as SecretsStatus);
  }

  function renderSecurity(status: SecretsStatus, note?: string): void {
    const locked = status.state === "locked";
    const keyStatus = h("span", "text-[11.5px]", "");
    if (note) setStatus(keyStatus, "saved", note);

    const stateLine = h(
      "div",
      "flex items-center gap-2",
      badge(
        status.state,
        locked ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200",
      ),
      h(
        "span",
        "text-[12.5px] text-neutral-600",
        locked
          ? "Stored credentials cannot be read until the key is unlocked."
          : status.mode === "vt"
          ? "Key mode: vt:// — unlocking takes one vt approval per process start."
          : "Key mode: file — the key sits raw in master.key; switch to vt:// to require an approval.",
      ),
    );

    const body: HTMLElement[] = [stateLine];

    if (locked) {
      // The reason is the repair instruction; hiding it would leave only "locked".
      body.push(h("p", "text-[12.5px] leading-snug text-red-600", status.reason ?? "No reason reported."));
      const unlock = button("Unlock", true);
      unlock.onclick = () => {
        setStatus(keyStatus, "saving", "unlocking… (vt mode waits on your approval)");
        void (async () => {
          const res = await sendJson("/api/secrets/unlock", {});
          if (!res.ok) return setStatus(keyStatus, "failed", await failure(res, "Could not unlock"));
          renderSecurity((await res.json()) as SecretsStatus, "Unlocked — channels are starting.");
        })();
      };
      body.push(h("div", "flex items-center gap-3", unlock, keyStatus));
    } else {
      const rotate = async (mode: "vt" | "file", confirmText: string, note: string): Promise<void> => {
        if (!window.confirm(confirmText)) return;
        setStatus(keyStatus, "saving", mode === "vt" ? "rotating… (vt asks for an approval)" : "rotating…");
        const res = await sendJson("/api/secrets/rotate", { mode });
        if (!res.ok) return setStatus(keyStatus, "failed", await failure(res, "Could not rotate"));
        renderSecurity((await res.json()) as SecretsStatus, note);
      };
      const mode = status.mode ?? "file";
      const keep = button("Rotate key", true);
      keep.onclick = () => void rotate(
        mode,
        "Generate a new master key? Stored credentials stay valid; the old key stops working.",
        "Rotated.",
      );
      const other = mode === "vt" ? "file" : "vt";
      const switchBtn = button(other === "vt" ? "Switch to vt://" : "Switch to file");
      switchBtn.onclick = () => void rotate(
        other,
        other === "vt"
          ? "Move the master key into vt? Every process start will then wait on a vt approval."
          : "Store the master key raw in master.key? Anyone who can read the file can read every credential.",
        other === "vt" ? "Switched to vt:// mode." : "Switched to file mode.",
      );
      body.push(h("div", "flex items-center gap-3", keep, switchBtn, keyStatus));
    }

    securityColumn.replaceChildren(card(
      "Master key",
      "Seals every credential Pier stores (channel tokens, API keys). Rotating rewraps the key file; no stored data is rewritten.",
      ...body,
    ));
  }

  // --- view ----------------------------------------------------------------------

  function show(): void {
    renderTabs();
    if (topic === "instance") {
      pane.replaceChildren(instanceColumn);
      loadInstance();
    } else {
      pane.replaceChildren(securityColumn);
      void loadSecurity();
    }
  }

  return consoleView(root, show);
}
