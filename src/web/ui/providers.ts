// New-user provider setup: endpoint/model structure and authentication in one flow.

import type {
  ProviderApi,
  ProviderAuthType,
  ProviderInfo,
  ProviderSetup,
} from "../../core/types.js";
import { failure, sendJson } from "./api.js";
import { h } from "./dom.js";
import { badge, button, CONTROL, empty, field, input, textarea } from "./form.js";
import { openAuthFlow, type AuthFlow } from "./auth-flow.js";

const POPULAR = ["anthropic", "openai", "openai-codex", "google", "openrouter", "deepseek"];
const APIS: [string, ProviderApi][] = [
  ["OpenAI Chat Completions", "openai-completions"],
  ["OpenAI Responses", "openai-responses"],
  ["Anthropic Messages", "anthropic-messages"],
  ["Google Generative AI", "google-generative-ai"],
];
const CUSTOM = "__custom__";

export async function openProviders(pane: HTMLElement): Promise<void> {
  const add = button("Add provider", true);
  add.classList.add("ml-auto");
  const bar = h(
    "div", "flex flex-none items-center gap-3 border-b border-neutral-200 px-4 py-2",
    h("span", "font-mono text-[12.5px] text-neutral-500", "Providers"),
    add,
  );
  const content = h("div", "min-h-0 flex-1 overflow-y-auto");
  pane.replaceChildren(bar, content);

  const load = async (): Promise<void> => {
    content.replaceChildren(h("p", "px-4 py-3 text-[13px] text-neutral-400", "Loading…"));
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) {
        content.replaceChildren(empty(await failure(res, "Could not load providers")));
        return;
      }
      const providers = (await res.json()) as ProviderInfo[];
      add.onclick = () => openSetup(providers, undefined, load);
      render(providers);
    } catch (err) {
      content.replaceChildren(empty(`Could not load providers: ${String(err)}`));
    }
  };

  const logout = async (provider: ProviderInfo): Promise<void> => {
    if (!window.confirm(`Remove the stored credential for ${provider.name}?`)) return;
    try {
      const res = await sendJson(`/api/providers/${encodeURIComponent(provider.id)}/logout`, {});
      if (!res.ok) {
        window.alert(await failure(res, "Could not remove credential"));
        return;
      }
      await load();
    } catch (err) {
      window.alert(`Could not remove credential: ${String(err)}`);
    }
  };

  const render = (providers: ProviderInfo[]): void => {
    const configured = providers.filter((provider) => provider.configured);
    if (!configured.length) {
      content.replaceChildren(empty("No providers configured."));
      return;
    }
    content.replaceChildren(...configured.map((provider) => {
      const identity = h(
        "div", "min-w-0 flex-1",
        h("div", "truncate text-[13px] font-medium text-neutral-700", provider.name),
        h("div", "truncate font-mono text-[11px] text-neutral-400", provider.id),
      );
      const authLabel = provider.stored === "api_key"
        ? "API key"
        : provider.stored === "oauth" ? "OAuth" : provider.source ?? "configured";
      const endpoint = provider.endpoint ?? "Default endpoint";
      const state = h(
        "div", "flex min-w-32 flex-col items-start gap-1",
        badge("configured", "bg-emerald-50 text-emerald-700 ring-emerald-200"),
        h("span", "max-w-48 truncate text-[11px] text-neutral-500", authLabel),
        h("span", "max-w-48 truncate text-[11px] text-neutral-400", endpoint),
      );
      state.title = endpoint;
      const actions = h("div", "flex flex-wrap justify-end gap-1.5");
      if (provider.builtin || (provider.api && provider.models)) {
        const edit = button("Edit");
        edit.onclick = () => openSetup(providers, provider, load);
        actions.append(edit);
      }
      if (provider.stored) {
        const remove = button("Remove credential");
        remove.onclick = () => void logout(provider);
        actions.append(remove);
      }
      return h(
        "div",
        "grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,auto)_minmax(9rem,auto)] items-center gap-3 border-b border-neutral-100 px-4 py-2.5 max-sm:grid-cols-[1fr_auto]",
        identity, state, actions,
      );
    }));
  };

  await load();
}

function providerOptions(select: HTMLSelectElement, providers: ProviderInfo[]): void {
  const candidates = providers.filter((provider) =>
    !provider.configured && provider.methods.length &&
    (provider.builtin || (provider.api !== undefined && provider.models !== undefined))
  );
  const appendGroup = (label: string, entries: ProviderInfo[]) => {
    if (!entries.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    group.append(...entries.map((provider) => new Option(provider.name, provider.id)));
    select.append(group);
  };
  appendGroup("Common", POPULAR.flatMap((id) => candidates.filter((provider) => provider.id === id)));
  appendGroup(
    "More providers",
    candidates
      .filter((provider) => provider.builtin && !POPULAR.includes(provider.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  appendGroup(
    "Custom providers",
    candidates.filter((provider) => !provider.builtin).sort((a, b) => a.name.localeCompare(b.name)),
  );
  select.append(new Option("Custom provider…", CUSTOM));
}

function openSetup(
  providers: ProviderInfo[],
  existing: ProviderInfo | undefined,
  reload: () => Promise<void>,
): void {
  const dialog = document.createElement("dialog");
  dialog.className =
    "m-auto w-[min(32rem,92vw)] rounded-lg border border-neutral-200 bg-white p-0 shadow-xl backdrop:bg-black/30";
  const providerSelect = document.createElement("select");
  providerSelect.className = CONTROL;
  if (!existing) providerOptions(providerSelect, providers);

  const customId = input();
  const customName = input();
  const endpoint = input();
  const api = document.createElement("select");
  api.className = CONTROL;
  api.append(...APIS.map(([label, value]) => new Option(label, value)));
  const models = textarea("", 4);
  models.placeholder = "model-id\nanother-model-id";
  const reasoning = document.createElement("input");
  reasoning.type = "checkbox";
  const auth = document.createElement("select");
  auth.className = CONTROL;
  const fields = h("div", "flex flex-col gap-4");
  const status = h("span", "text-[11.5px] text-red-600", "");
  const cancel = button("Cancel");
  const save = button(existing ? "Save" : "Add", true);
  save.type = "submit";

  const selected = (): ProviderInfo | undefined =>
    existing ?? providers.find((provider) => provider.id === providerSelect.value);

  const populate = (): void => {
    const provider = selected();
    const custom = provider ? !provider.builtin : providerSelect.value === CUSTOM;
    customId.value = provider?.id ?? "";
    customId.disabled = existing !== undefined;
    customName.value = provider?.name ?? "";
    endpoint.value = provider?.endpoint ?? "";
    api.value = provider?.api ?? "openai-completions";
    models.value = provider?.models?.map((model) => model.id).join("\n") ?? "";
    const capabilities = provider?.models?.map((model) => model.reasoning) ?? [];
    reasoning.checked = capabilities.length ? capabilities.every(Boolean) : !provider;
    reasoning.indeterminate = capabilities.some(Boolean) && !capabilities.every(Boolean);

    const authOptions: HTMLOptionElement[] = [];
    if (provider?.configured) authOptions.push(new Option("Keep current authentication", ""));
    const methods = provider?.methods ?? [{ type: "api_key" as const, name: "API key" }];
    for (const method of methods.filter((candidate) => provider?.builtin !== false || candidate.type === "api_key")) {
      authOptions.push(new Option(method.name, method.type));
    }
    auth.replaceChildren(...authOptions);

    const rows: HTMLElement[] = [];
    if (!existing) rows.push(field("Provider", providerSelect));
    if (custom) {
      rows.push(
        field("Provider ID", customId),
        field("Display name", customName),
        field("Endpoint", endpoint),
        field("API format", api),
        field("Models", models),
        field("Model capabilities", h(
          "label", "flex items-center gap-2 text-[12.5px] text-neutral-600",
          reasoning, h("span", "", "Reasoning"),
        )),
      );
    } else {
      endpoint.placeholder = "Provider default";
      rows.push(field("Endpoint", endpoint));
    }
    rows.push(field("Authentication", auth));
    fields.replaceChildren(...rows);
  };
  providerSelect.onchange = populate;
  populate();

  const form = h(
    "form", "flex flex-col gap-4 px-4 py-3",
    fields,
    h("div", "flex items-center justify-end gap-2", status, cancel, save),
  ) as HTMLFormElement;
  let submitting = false;
  cancel.onclick = () => {
    if (!submitting) dialog.close();
  };
  dialog.oncancel = (event) => {
    if (submitting) event.preventDefault();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (submitting) return;
    status.textContent = "";
    const provider = selected();
    const custom = provider ? !provider.builtin : providerSelect.value === CUSTOM;
    const setup: ProviderSetup = custom
      ? {
          kind: "custom",
          id: customId.value.trim(),
          ...(customName.value.trim() ? { name: customName.value.trim() } : {}),
          endpoint: endpoint.value.trim(),
          api: api.value as ProviderApi,
          models: [...new Set(models.value.split("\n").map((id) => id.trim()).filter(Boolean))]
            .map((id) => ({
              id,
              reasoning: reasoning.indeterminate
                ? provider?.models?.find((model) => model.id === id)?.reasoning ?? reasoning.checked
                : reasoning.checked,
            })),
        }
      : {
          kind: "builtin",
          id: provider!.id,
          ...(endpoint.value.trim() ? { endpoint: endpoint.value.trim() } : {}),
        };
    const authType = (auth.value || null) as ProviderAuthType | null;
    submitting = true;
    save.disabled = true;
    cancel.disabled = true;
    void (async () => {
      try {
        const res = await sendJson("/api/providers/setup", { setup, authType });
        if (!res.ok) {
          status.textContent = await failure(res, "Could not configure provider");
          return;
        }
        dialog.close();
        if (res.status === 202) {
          const methodName = auth.selectedOptions[0]?.textContent ?? "Authentication";
          openAuthFlow((await res.json()) as AuthFlow, setup.id, methodName, () => void reload());
        } else {
          await reload();
        }
      } catch (err) {
        status.textContent = `Could not configure provider: ${String(err)}`;
      } finally {
        submitting = false;
        save.disabled = false;
        cancel.disabled = false;
      }
    })();
  };

  dialog.append(
    h("div", "border-b border-neutral-200 px-4 py-2.5 text-[14px] font-semibold", existing ? `Edit ${existing.name}` : "Add provider"),
    form,
  );
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  (existing ? endpoint : providerSelect).focus();
}
