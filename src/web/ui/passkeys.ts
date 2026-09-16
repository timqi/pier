// Console → Settings → Security → Passkeys: the WebAuthn registration call with
// the base64url ↔ bytes conversion done by hand (Safari lacks
// `parseCreationOptionsFromJSON`), and the list with its Remove.

import { failure, getJson, postJson, refused, sendJson } from "./api.js";
import { agoLabel, h } from "./dom.js";
import { button, card, deviceRow, empty, input, setStatus } from "./form.js";

/** What /api/passkeys answers: never the public key. */
interface PasskeyList {
  enabled: boolean;
  reason?: string;
  passkeys: { id: string; label: string; createdAt: number; lastUsedAt: number | null; transports: string[] }[];
}

/** The creation options as the server sends them: binary fields base64url. */
interface CreationOptionsJson extends Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials: { type: "public-key"; id: string; transports: string[] }[];
}

const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const text = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createPasskeysCard(): { el: HTMLElement; load(): Promise<boolean> } {
  const list = h("div", "flex flex-col gap-2");
  const status = h("span", "text-[11.5px]", "");
  const label = input();
  label.placeholder = "Label, e.g. MacBook Touch ID";
  label.autocomplete = "off";
  label.maxLength = 80;
  const add = button("Add a passkey", true);
  const addRow = h("div", "flex flex-wrap items-center gap-3", label, add, status);
  // Says why the form is gone: hiding it alone would read as a missing feature.
  const note = h("p", "hidden text-[12.5px] leading-snug text-neutral-600");
  const off = h("p", "hidden text-[12px] text-neutral-400");

  function render(got: PasskeyList): void {
    off.textContent = got.reason ?? "";
    off.classList.toggle("hidden", got.enabled);
    addRow.classList.toggle("hidden", !got.enabled);
    note.textContent = "Password sign-in is off while a passkey is registered; remove every passkey to turn it back on.";
    note.classList.toggle("hidden", !got.passkeys.length);
    if (!got.passkeys.length) {
      list.replaceChildren(empty("No passkey is registered."));
      return;
    }
    list.replaceChildren(...got.passkeys.map((p) => {
      const remove = button("Remove");
      remove.onclick = () => {
        remove.disabled = true;
        void (async () => {
          const error = await refused(`/api/passkeys/${encodeURIComponent(p.id)}`, "DELETE", "Could not remove it");
          if (error) setStatus(status, "failed", error);
          else setStatus(status, "saved", "Removed.");
          await load();
        })();
      };
      const used = p.lastUsedAt ? `last used ${agoLabel(p.lastUsedAt)}` : "never used";
      const via = p.transports.length ? ` · ${p.transports.join(", ")}` : "";
      return deviceRow(p.label, `added ${agoLabel(p.createdAt)} · ${used}${via}`, remove);
    }));
  }

  async function register(): Promise<void> {
    if (!window.PublicKeyCredential) return setStatus(status, "failed", "This browser has no passkey support.");
    add.disabled = true;
    setStatus(status, "saving", "asking this browser…");
    try {
      const opts = await postJson<CreationOptionsJson>("/api/passkeys/register/options", {}, "Could not start");
      if (!opts.ok) return setStatus(status, "failed", opts.error);
      const publicKey: PublicKeyCredentialCreationOptions = {
        ...opts.value,
        challenge: bytes(opts.value.challenge),
        user: { ...opts.value.user, id: bytes(opts.value.user.id) },
        excludeCredentials: opts.value.excludeCredentials.map((cred) => ({
          ...cred,
          id: bytes(cred.id),
          transports: cred.transports as AuthenticatorTransport[],
        })),
      };
      const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
      if (!cred) return setStatus(status, "failed", "No passkey was created.");
      const response = cred.response as AuthenticatorAttestationResponse;
      const res = await sendJson("/api/passkeys/register/verify", {
        id: cred.id,
        type: cred.type,
        label: label.value,
        response: {
          clientDataJSON: text(response.clientDataJSON),
          attestationObject: text(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        },
      });
      if (!res.ok) return setStatus(status, "failed", await failure(res, "Could not register it"));
      label.value = "";
      render((await res.json()) as PasskeyList);
      setStatus(status, "saved", "Added. The password is off until every passkey is removed.");
    } catch (err) {
      // NotAllowedError is the browser's word for a dismissed or timed-out prompt.
      const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
      setStatus(status, "failed", cancelled ? "The prompt was dismissed or timed out." : `Could not add it: ${String(err)}`);
    } finally {
      add.disabled = false;
    }
  }
  add.onclick = () => void register();

  async function load(): Promise<boolean> {
    const got = await getJson<PasskeyList>("/api/passkeys", "Could not load passkeys");
    if (!got.ok) {
      list.replaceChildren(empty(got.error));
      return false;
    }
    render(got.value);
    return got.value.passkeys.length > 0;
  }

  const el = card(
    "Passkeys",
    "Sign in with Touch ID, Windows Hello, a phone or a security key instead of the password. Bound to the public URL's host.",
    list,
    note,
    off,
    addRow,
  );
  return { el, load };
}
