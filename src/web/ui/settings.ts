// Console → Settings: the one place the instance is configured, one tab per
// topic. Models (provider auth and the operator's menu — one topic: what the
// agent runs on), Channels and Agent host their own modules; this file owns
// the topic strip and the cards small enough to live here (Instance,
// Security). Storage is not the split — a db row and a Pi file are both
// "settings" to the person opening this page.

import { failure, getJson, sendJson } from "./api.js";
import { createChannelsView } from "./channels.js";
import { createConfigView } from "./config.js";
import { agoLabel, consoleView, h, type ConsoleView } from "./dom.js";
import { badge, button, card, empty, field, input, pill, setStatus } from "./form.js";
import { createModelMenuPane } from "./model-menu.js";
import { createNotificationsCard } from "./notifications.js";
import { openProviders } from "./providers.js";

type Topic = "instance" | "models" | "channels" | "files" | "security";
// Setup order: what you need first sits first — what to run on, then what the
// agent is made of, then where it talks, then the instance's own facts.
const TOPICS: [Topic, string][] = [
  ["models", "Models"],
  ["files", "Agent"],
  ["channels", "Channels"],
  ["instance", "Instance"],
  ["security", "Security"],
];
const isTopic = (v: string | undefined): v is Topic => TOPICS.some(([id]) => id === v);
/** Where you left off, so reopening Settings lands on the tab you were on. */
const TOPIC_KEY = "pier.settingsTopic";

/** What /api/secrets answers — never key material. */
interface SecretsStatus {
  state: "locked" | "unlocked";
  mode: "vt" | "file" | null;
  reason?: string;
}

/** What /api/devices answers: one signed-in browser, never its token. */
interface Device {
  id: string;
  createdAt: number;
  seenAt: number;
  ip: string;
  agent: string;
  current: boolean;
}

/** The user agent as a person recognizes their own browser. A guess by
 *  design — the exact string is on the row's tooltip. */
function deviceName(agent: string): string {
  // Edge before Chrome: its user agent says both, Chrome first.
  const browser = /\bEdg\//.test(agent)
    ? "Edge"
    : /\b(Firefox|Chrome|Safari)\/[\d.]+/.exec(agent)?.[1];
  const platform = /\(([^;)]+)/.exec(agent)?.[1]?.trim();
  const name = [browser, platform].filter(Boolean).join(" · ");
  return name || agent || "unknown client";
}

export function createSettingsView(
  root: HTMLElement,
  getCwds: () => string[],
  /** Tab clicks route (#/settings/<topic>) so refresh and Back keep the tab. */
  onTopic: (topic: string) => void,
): ConsoleView {
  const stored = localStorage.getItem(TOPIC_KEY) ?? undefined;
  let topic: Topic = isTopic(stored) ? stored : "models";

  // Header and tabs sit above the topic host, which scrolls (or lays out) on
  // its own — the strip stays visible however long a topic page gets.
  const header = h(
    "header",
    "flex h-10 flex-none items-center gap-3 border-b border-neutral-200 bg-white px-4 max-md:hidden",
    h("span", "font-medium", "Settings"),
  );
  const tabs = h("div", "tabstrip bg-white");

  function renderTabs(): void {
    tabs.replaceChildren(
      ...TOPICS.map(([id, label]) => pill(label, id === topic, () => onTopic(id))),
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
      publicUrl ? `Saved — boards link as ${publicUrl}/p/<slug>-<token>/` : "Cleared.",
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

  // --- Security: password ----------------------------------------------------------

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
    // The change revoked every cookie, this browser's included — hand the
    // person straight to the form their new password now opens.
    setStatus(pwStatus, "saved", "Changed. Sign in again with the new password.");
    location.href = "/login";
  }
  pwSave.onclick = () => void savePassword();
  confirm.onkeydown = (ev) => {
    if (ev.key === "Enter") void savePassword();
  };

  const pwCard = card(
    "Password",
    "One shared password guards every page and API route. Changing it signs out every signed-in browser, this one included.",
    field("Current password", current),
    field("New password", next, { hint: "At least 10 characters." }),
    field("Repeat new password", confirm),
    h("div", "flex items-center gap-3", pwSave, pwStatus),
  );

  // --- Instance: reload ------------------------------------------------------------
  // Saving in the Console already recycles sessions. This is for the changes
  // the Console never saw: an agent that rewrote AGENTS.md, a skill dropped in
  // over ssh, a Pi config edited in an editor.

  const reload = button("Reload", true);
  const reloadStatus = h("span", "text-[11.5px]", "");

  reload.onclick = () => {
    reload.disabled = true;
    setStatus(reloadStatus, "saving", "reloading…");
    void (async () => {
      const res = await sendJson("/api/reload", {});
      reload.disabled = false;
      if (!res.ok) return setStatus(reloadStatus, "failed", await failure(res, "Could not reload"));
      const { recycled, busy } = (await res.json()) as { recycled: number; busy: number };
      // Both numbers, always: "nothing was live" and "a turn is still holding
      // the old configuration" look identical otherwise, and the second is the
      // only reason a change can still fail to show up. Neutral, not green,
      // while one is — green would claim the change is everywhere.
      const done = recycled ? `Recycled ${recycled} session(s).` : "No idle session needed it.";
      const held = busy ? ` ${busy} still mid-turn — they take it when the turn ends.` : "";
      setStatus(reloadStatus, busy ? "idle" : "saved", done + held);
    })();
  };

  const reloadCard = card(
    "Reload configuration",
    "Re-reads channel configuration and lets go of idle sessions, so the next message opens them with the current agent files, skills and credentials. Saving here does this on its own — use it after something outside the Console changed a file.",
    h("div", "flex items-center gap-3", reload, reloadStatus),
  );

  // --- Security: signed-in devices -----------------------------------------------------

  const devicesBody = h("div", "flex flex-col gap-2");
  const devicesStatus = h("span", "text-[11.5px]", "");
  /** One sign-out call, and the sentence when it did not happen — a refusal
   *  and a dead network both have to reach the page (§5b), and the two buttons
   *  below would otherwise each have their own idea of that. */
  async function endSession(url: string, failed: string): Promise<boolean> {
    setStatus(devicesStatus, "saving", "signing out…");
    try {
      const res = await sendJson(url, {});
      if (res.ok) return true;
      setStatus(devicesStatus, "failed", await failure(res, failed));
    } catch (err) {
      setStatus(devicesStatus, "failed", `${failed}: ${String(err)}`);
    }
    return false;
  }

  const signOut = button("Sign out");
  signOut.onclick = () => {
    signOut.disabled = true;
    // Only leave once the session is actually gone: a failed call that still
    // redirected would show the login page to a browser that is still signed in.
    void endSession("/logout", "Could not sign out").then((ok) => {
      if (ok) location.href = "/login";
      else signOut.disabled = false;
    });
  };

  function renderDevices(devices: Device[]): void {
    devicesBody.replaceChildren(...devices.map((d) => {
      const end = button(d.current ? "This browser" : "Sign out");
      end.disabled = d.current; // ending this one is the button below, which also leaves
      end.onclick = () => {
        end.disabled = true;
        const url = `/api/devices/${encodeURIComponent(d.id)}/signout`;
        void endSession(url, "Could not sign it out").then((ok) => {
          if (!ok) return void (end.disabled = false);
          setStatus(devicesStatus, "saved", "Signed out.");
          void loadDevices();
        });
      };
      const line = h("div", "flex min-w-0 flex-col", h(
        "span",
        "truncate text-[12.5px] text-neutral-700",
        deviceName(d.agent),
      ));
      // The raw agent string stays reachable: the pretty name is a guess, and
      // "is that mine?" is answered by the thing the browser actually sent.
      line.title = d.agent;
      line.append(h(
        "span",
        "truncate text-[11.5px] text-neutral-400",
        `${d.ip} · seen ${agoLabel(d.seenAt)} · signed in ${agoLabel(d.createdAt)}`,
      ));
      return h(
        "div",
        "flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2",
        line,
        end,
      );
    }));
  }

  async function loadDevices(): Promise<void> {
    const got = await getJson<Device[]>("/api/devices", "Could not load signed-in devices");
    if (!got.ok) {
      devicesBody.replaceChildren(empty(got.error));
      return;
    }
    renderDevices(got.value);
  }

  const devicesCard = card(
    "Signed-in devices",
    "One row per browser holding a session. Signing one out invalidates its cookie immediately; sessions expire on their own 7 days after last use.",
    devicesBody,
    h("div", "flex items-center gap-3", signOut, devicesStatus),
  );

  const instanceColumn = h(
    "div",
    "mx-auto flex max-w-2xl flex-col gap-6",
    urlCard,
    // Per browser, not per instance — but this is the page a person opens to
    // configure Pier, and a second place for one toggle would be a third copy
    // of the same vocabulary.
    createNotificationsCard(),
    reloadCard,
  );

  // --- topic hosts -----------------------------------------------------------------
  // Simple topics share one scroll wrapper each; Channels and Agent files are
  // whole modules that manage their own layout, hosted as child console views
  // and shown/hidden with the tab. The tint behind the cards is what keeps a
  // page of white cards from reading as one flat sheet.

  const wrap = (content: HTMLElement): HTMLElement =>
    h("div", "hidden min-h-0 flex-1 overflow-y-auto bg-neutral-50/60", h("div", "px-4 py-5", content));

  // One topic, two halves: the endpoints that can be reached, then the few
  // models this deployment favors. Configuring auth and then pinning what to
  // reach for is one sitting, and splitting it made the second half look
  // optional.
  const modelMenu = createModelMenuPane();
  // Same column width and card chrome as the menu below it, or the two halves
  // of one topic read as two pages.
  const providersBox = h(
    "div",
    "mx-auto flex w-full min-w-0 max-w-3xl flex-col rounded-xl border border-neutral-200 bg-white shadow-xs",
  );

  const channelsHost = h("section", "hidden min-h-0 flex-1 flex-col");
  const channelsChild = createChannelsView(channelsHost);
  const filesHost = h("section", "hidden min-h-0 flex-1 flex-col");
  const filesChild = createConfigView(filesHost, getCwds);

  function loadInstance(): void {
    void (async () => {
      const got = await getJson<{ publicUrl: string }>("/api/settings", "Could not load settings");
      if (!got.ok) return setStatus(urlStatus, "failed", got.error);
      urlInput.value = got.value.publicUrl;
      urlStatus.textContent = "";
    })();
  }

  // --- Security: master key --------------------------------------------------------
  // One tab for who gets in and what the credentials are sealed with. Only the
  // key card re-renders (per status); password and devices are built once, so
  // the column is written out around whatever the key card currently is.

  const securityColumn = h("div", "mx-auto flex max-w-2xl flex-col gap-6");
  const showKeyCard = (el: HTMLElement): void => securityColumn.replaceChildren(el, pwCard, devicesCard);

  async function loadSecurity(): Promise<void> {
    pwStatus.textContent = "";
    devicesStatus.textContent = "";
    void loadDevices();
    const got = await getJson<SecretsStatus>("/api/secrets", "Could not load key status");
    if (!got.ok) {
      showKeyCard(empty(got.error));
      return;
    }
    renderSecurity(got.value);
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

    // What vt is, once, next to the button that hands it the key.
    const vtDoc = h(
      "a",
      "text-indigo-600 hover:underline",
      "vt",
    ) as HTMLAnchorElement;
    vtDoc.href = "https://github.com/timqi/vt";
    vtDoc.target = "_blank";
    vtDoc.rel = "noreferrer";
    const vtNote = h(
      "p",
      "text-[12px] leading-snug text-neutral-500",
      vtDoc,
      " is a small local KMS: it keeps the key wrapped and releases it only on an"
        + " explicit approval — Touch ID on a Mac, a phone passkey on a headless host."
        + " Pier only stores the vt:// record, so master.key alone unlocks nothing.",
    );

    const body: HTMLElement[] = [stateLine, vtNote];

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

    // vt's own diagnosis, under the buttons that need it: which config file and
    // env vt reads, how it routes an approval, whether an agent answers. Only
    // where it can be the answer — a locked instance, or vt mode that could
    // lock on the next start. Pier does not edit vt's config; vt owns that.
    if (locked || status.mode === "vt") {
      const report = h("pre", "hidden overflow-x-auto rounded-lg bg-neutral-50 p-3 text-[11.5px] leading-snug text-neutral-700");
      const doctor = button("vt doctor");
      doctor.onclick = () => {
        doctor.disabled = true;
        report.classList.remove("hidden");
        report.textContent = "running vt doctor…";
        void (async () => {
          const got = await getJson<{ report: string }>("/api/secrets/doctor", "Could not run vt doctor");
          // The failure is the diagnosis too — an absent binary reads as one.
          report.textContent = got.ok ? got.value.report : got.error;
          doctor.disabled = false;
        })();
      };
      body.push(h("div", "flex items-center gap-3", doctor), report);
    }

    showKeyCard(card(
      "Master key",
      "Seals every credential Pier stores (channel tokens, API keys). Rotating rewraps the key file; no stored data is rewritten.",
      ...body,
    ));
  }

  // --- view ----------------------------------------------------------------------

  const instancePane = wrap(instanceColumn);
  const modelsPane = wrap(h("div", "flex flex-col gap-6", providersBox, modelMenu.el));
  const securityPane = wrap(securityColumn);
  const simplePanes: [Topic, HTMLElement, () => void][] = [
    ["instance", instancePane, loadInstance],
    ["models", modelsPane, () => {
      void openProviders(providersBox);
      modelMenu.load();
    }],
    ["security", securityPane, () => void loadSecurity()],
  ];

  root.append(header, tabs, instancePane, modelsPane, channelsHost, filesHost, securityPane);

  function show(arg?: string): void {
    if (isTopic(arg)) topic = arg;
    localStorage.setItem(TOPIC_KEY, topic);
    renderTabs();
    for (const [id, pane, load] of simplePanes) {
      const active = id === topic;
      pane.classList.toggle("hidden", !active);
      if (active) load();
    }
    if (topic === "channels") channelsChild.show();
    else channelsChild.hide();
    if (topic === "files") filesChild.show();
    else filesChild.hide();
  }

  return consoleView(root, show);
}
