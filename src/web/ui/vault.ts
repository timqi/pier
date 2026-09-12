// Settings → Vault: the names `pier vault run` may ask for, filed here and
// never read back — a secret is replaced or removed, not revealed.

import { failure, getJson, refused, sendJson } from "./api.js";
import { agoLabel, h } from "./dom.js";
import { badge, button, card, empty, field, input, segmented, setStatus } from "./form.js";

type Level = "auto" | "approve";

/** What /api/vault answers: one row per name, never a value. */
interface VaultRow {
  name: string;
  level: Level;
  updatedAt: number;
}

const LEVEL_STYLE: Record<Level, string> = {
  auto: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  approve: "bg-amber-50 text-amber-700 ring-amber-200",
};

/** The one line that says what the toggle decides. */
const LEVEL_NOTE: Record<Level, string> = {
  auto: "auto = the agent may use this freely: any session, subagent or local process gets the value without asking.",
  approve: "approve = every use pauses for a vt approval; the value never leaves vt's keeping.",
};

const NAME_RULE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function createVaultPane(): { el: HTMLElement; show(query?: string): void } {
  let level: Level = "auto";

  // --- the table ---------------------------------------------------------------

  const listBox = h("div", "flex flex-col gap-2");
  const listStatus = h("span", "text-[11.5px]", "");

  function row(entry: VaultRow): HTMLElement {
    const remove = button("Remove");
    remove.onclick = () => {
      if (!window.confirm(`Remove ${entry.name}? A command naming it fails until it is filed again.`)) return;
      remove.disabled = true;
      void (async () => {
        const error = await refused(`/api/vault/${encodeURIComponent(entry.name)}`, "DELETE", "Could not remove it");
        if (error) {
          remove.disabled = false;
          return setStatus(listStatus, "failed", error);
        }
        setStatus(listStatus, "saved", `Removed ${entry.name}.`);
        await load();
      })();
    };
    const line = h(
      "div",
      "flex min-w-0 flex-col gap-1",
      h("span", "truncate font-mono text-[12.5px] text-neutral-700", entry.name),
      h(
        "span",
        "flex items-center gap-1.5 text-[11.5px] text-neutral-400",
        badge(entry.level, LEVEL_STYLE[entry.level]),
        `updated ${agoLabel(entry.updatedAt)}`,
      ),
    );
    return h("div", "flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2", line, remove);
  }

  async function load(): Promise<void> {
    const got = await getJson<VaultRow[]>("/api/vault", "Could not load the vault");
    if (!got.ok) return void listBox.replaceChildren(empty(got.error));
    listBox.replaceChildren(...(got.value.length
      ? got.value.map(row)
      : [empty("No secrets yet. File one below; a skill names it by this name.")]));
  }

  const listCard = card(
    "Secrets",
    "Named values `pier vault run` puts into one command's environment. The agent's context never holds them; a name it cannot find fails with a link back here. Channel tokens live here too (SLACK_TOKEN, LARK_APP_ID…): removing one empties that channel's credential.",
    listBox,
    listStatus,
  );

  // --- the add row -------------------------------------------------------------
  // No edit-in-place: filing a name that exists replaces its value (rotation).

  const name = input();
  name.classList.add("font-mono");
  name.placeholder = "SLACK_TOKEN";
  name.autocomplete = "off";
  name.spellcheck = false;
  const value = input("", "password");
  value.placeholder = "paste the secret";
  value.autocomplete = "new-password";
  const note = h("span", "text-[11.5px] leading-snug text-neutral-400", LEVEL_NOTE[level]);
  const levelBox = h("div", "flex flex-col gap-1.5");
  const addStatus = h("span", "text-[11.5px]", "");
  const save = button("File secret", true);

  function renderLevel(): void {
    note.textContent = LEVEL_NOTE[level];
    levelBox.replaceChildren(
      segmented<Level>([["auto", "auto"], ["approve", "approve"]], level, (next) => {
        level = next;
        renderLevel();
      }),
      note,
    );
  }

  async function file(): Promise<void> {
    // Typed as an env-var name; the server holds the same rule.
    const key = name.value.trim();
    if (!NAME_RULE.test(key)) {
      return setStatus(addStatus, "failed", "Name must be A-Z, 0-9 and _, starting with a letter, like SLACK_TOKEN.");
    }
    if (!value.value) return setStatus(addStatus, "failed", "Paste the secret first.");
    save.disabled = true;
    setStatus(addStatus, "saving", level === "approve" ? "filing… (vt creates the record; approve if it asks)" : "filing…");
    const res = await sendJson(`/api/vault/${encodeURIComponent(key)}`, { level, value: value.value }, "PUT");
    save.disabled = false;
    if (!res.ok) return setStatus(addStatus, "failed", await failure(res, "Could not file it"));
    // The value leaves the field the moment it is stored: nothing on this page holds it.
    value.value = "";
    name.value = "";
    setStatus(addStatus, "saved", `Filed ${key} (${level}). Rotate it by filing the same name again.`);
    await load();
  }
  save.onclick = () => void file();
  value.onkeydown = (ev) => {
    if (ev.key === "Enter") void file();
  };

  const addCard = card(
    "File a secret",
    "Filing a name that exists replaces its value; commands already running keep the one they were given.",
    field("Name", name, { hint: "An environment variable name. Skills name it by convention, e.g. SLACK_BOT_TOKEN=SLACK_TOKEN." }),
    field("Level", levelBox),
    field("Value", value, { hint: "Stored sealed (auto) or as a vt:// record (approve); shown to nobody afterwards." }),
    h("div", "flex items-center gap-3", save, addStatus),
  );

  const el = h("div", "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6", listCard, addCard);

  /** `?name=X` is the link an agent's "no secret named X" error carries: the
   *  add row opens with the name filled and the value field ready for the paste. */
  function show(query?: string): void {
    renderLevel();
    listStatus.textContent = "";
    addStatus.textContent = "";
    void load();
    const wanted = new URLSearchParams(query ?? "").get("name");
    if (wanted && NAME_RULE.test(wanted)) {
      name.value = wanted;
      value.focus();
      addCard.scrollIntoView({ block: "nearest" });
    }
  }

  return { el, show };
}
