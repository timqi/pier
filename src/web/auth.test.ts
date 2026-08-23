import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { AuthStore, requireAuth, registerAuthRoutes } from "./auth.js";

/** A store on a throwaway file, plus the password it printed on first boot. */
function store(path = join(mkdtempSync(join(tmpdir(), "pier-auth-")), "pier.db")): {
  store: AuthStore;
  password: string;
  path: string;
  db: DatabaseSync;
} {
  let printed = "";
  const db = openDb(path);
  const s = new AuthStore(db, (m) => {
    printed = m;
  });
  return {
    store: s,
    password: printed.match(/[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}/)?.[0] ?? "",
    path,
    db,
  };
}

/** A guarded app with the same wiring order main.ts uses. */
function app(s: AuthStore): Hono {
  const a = new Hono();
  a.use("*", requireAuth(s));
  registerAuthRoutes(a, s);
  a.get("/", (c) => c.text("workbench"));
  a.get("/api/sessions", (c) => c.json([]));
  a.post("/api/sessions", (c) => c.json({ ok: true }));
  a.get("/p/report/", (c) => c.text("published"));
  a.all("/p/report/", (c) => c.text("published write"));
  a.get("/boards/_assets/pier.css", (c) => c.text("css"));
  a.all("/boards/_assets/pier.css", (c) => c.text("css write"));
  a.get("/boards/report/", (c) => c.text("private"));
  return a;
}

/** Log in from a client id nothing else shares, so the throttle stays local. */
async function login(a: Hono, password: string, client: string = crypto.randomUUID()): Promise<Response> {
  return a.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": client },
    body: new URLSearchParams({ password, next: "/" }),
  });
}

const cookieOf = (res: Response): string => res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("AuthStore", () => {
  it("generates a password on first boot and prints it once", () => {
    const r = store();
    const { store: s, password, path } = r;
    expect(password).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(s.verify(password)).toBe(true);
    expect(s.verify("wrong")).toBe(false);

    // A restart reuses it, and says nothing.
    r.db.close();
    const again = store(path);
    expect(again.password).toBe("");
    expect(again.store.verify(password)).toBe(true);
    again.db.close();
  });

  // The file modes that keep this hash private are db.ts\'s job, and tested there.
  it("stores no plaintext", () => {
    const { password, db } = store();
    const row = db.prepare("SELECT salt, hash FROM auth WHERE id = 1").get() as {
      salt: string;
      hash: string;
    };
    expect(row.hash).not.toContain(password);
    expect(row.hash).toHaveLength(64);
    expect(row.salt).toHaveLength(32);
    db.close();
  });
});

describe("requireAuth", () => {
  it("refuses an API call with no cookie, and says so in JSON", async () => {
    const res = await app(store().store).request("/api/sessions");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("sends a navigation to the login form, remembering where it was going", async () => {
    const a = app(store().store);
    const res = await a.request("/boards/report/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fboards%2Freport%2F");
    // The login form is the one page strangers reach — not frameable either.
    const form = await a.request("/login");
    expect(form.status).toBe(200);
    expect(form.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses a write without redirecting it", async () => {
    const res = await app(store().store).request("/api/sessions", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("serves only read methods for published boards and their stylesheet", async () => {
    const a = app(store().store);
    for (const path of ["/p/report/", "/boards/_assets/pier.css"]) {
      expect((await a.request(path)).status).toBe(200);
      expect((await a.request(path, { method: "HEAD" })).status).toBe(200);
      for (const method of ["POST", "PATCH", "DELETE"]) {
        expect((await a.request(path, { method })).status).toBe(401);
      }
    }
    expect((await a.request("/p")).headers.get("location")).toBe("/login?next=%2Fp");
    expect((await a.request("/login", { method: "PUT" })).status).toBe(401);
  });

  it("rejects cross-origin writes with a valid cookie", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const post = (origin?: string) =>
      a.request("https://pier.example/api/sessions", {
        method: "POST",
        headers: { cookie, ...(origin ? { origin } : {}) },
      });

    expect((await post("https://other.example")).status).toBe(403);
    expect((await post("https://pier.example")).status).toBe(200);
    expect((await post()).status).toBe(200);

    // A local TLS proxy may rewrite Host for its upstream connection. Its
    // forwarded external host is trusted, and host names are case-insensitive.
    const proxied = await a.request("http://127.0.0.1:3141/api/sessions", {
      method: "POST",
      headers: {
        cookie,
        host: "127.0.0.1:3141",
        origin: "https://pier.example",
        "x-forwarded-host": "PIER.EXAMPLE:443",
      },
    }, {
      incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 443, remoteFamily: "IPv4" } },
    });
    expect(proxied.status).toBe(200);
  });
});

describe("login", () => {
  it("issues a cookie that opens the workbench", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const res = await login(a, password);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^pier_session=\d+\./);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    const api = await a.request("/api/sessions", { headers: { cookie } });
    expect(api.status).toBe(200);
    expect(api.headers.get("cache-control")).toBe("private, no-store");
    expect(api.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects the wrong password with the form again", async () => {
    const res = await login(app(store().store), "wrong");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Wrong password.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("only returns to a same-origin path", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const to = async (next: string) => {
      const res = await a.request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password, next }),
      });
      return res.headers.get("location");
    };
    // Both spellings of protocol-relative, and anything that is not a path.
    expect(await to("//evil.example/")).toBe("/");
    expect(await to("/\\evil.example/")).toBe("/");
    expect(await to("https://evil.example/")).toBe("/");
    // A real in-app destination survives, hash and all.
    expect(await to("/#/session/abc")).toBe("/#/session/abc");
  });

  it("throttles a client after too many failures", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const client = "10.0.0.9";
    for (let i = 0; i < 10; i++) expect((await login(a, "wrong", client)).status).toBe(401);
    const blocked = await login(a, password, client);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // The window is per client: another address is unaffected.
    expect((await login(a, password, "10.0.0.10")).status).toBe(302);
  });
});

describe("changing the password", () => {
  const change = (
    a: Hono,
    body: Record<string, string>,
    cookie: string = "",
    client: string = crypto.randomUUID(),
  ): Promise<Response> =>
    Promise.resolve(a.request("/api/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": client,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }));

  it("requires a session even when the current password is correct", async () => {
    const { store: s, password } = store();
    const res = await change(app(s), { current: password, next: "correct-horse" });
    expect(res.status).toBe(401);
    expect(s.verify(password)).toBe(true);
  });

  it("swaps the password and kills every cookie, the caller's included", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const before = cookieOf(await login(a, password));

    const res = await change(a, { current: password, next: "correct-horse" }, before);
    expect(res.status).toBe(200);
    expect(s.verify("correct-horse")).toBe(true);
    expect(s.verify(password)).toBe(false);

    // No cookie is re-issued — the caller's is cleared, and every cookie
    // signed under the old hash stops verifying. Everyone signs in again.
    expect(cookieOf(res)).toBe("pier_session=");
    expect((await a.request("/api/sessions", { headers: { cookie: before } })).status).toBe(401);
    expect((await login(a, "correct-horse")).status).toBe(302);
  });

  it("refuses the wrong current password, a short new one, and a guessing run", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));

    const wrong = await change(a, { current: "nope", next: "correct-horse" }, cookie);
    expect(wrong.status).toBe(403);
    const short = await change(a, { current: password, next: "short" }, cookie);
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Use at least 10 characters." });
    // Neither attempt changed anything.
    expect(s.verify(password)).toBe(true);

    // Same throttle as login: "change" answers the same guess "sign in" does.
    const client = "10.0.0.11";
    for (let i = 0; i < 10; i++) {
      expect((await change(a, { current: "nope", next: "correct-horse" }, cookie, client)).status).toBe(403);
    }
    expect((await change(a, { current: password, next: "correct-horse" }, cookie, client)).status).toBe(429);
    expect(s.verify(password)).toBe(true);
  });
});

describe("logout", () => {
  it("clears the cookie for a signed-in browser", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const res = await a.request("/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toBe("pier_session=");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("is behind the boundary like every other write", async () => {
    const res = await app(store().store).request("/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("the cookie", () => {
  it("dies with the password it was signed under", async () => {
    const { store: s, password, path, db } = store();
    const cookie = cookieOf(await login(app(s), password));

    // Rotation, the way an operator does it: drop the row, restart, new password.
    db.exec("DELETE FROM auth");
    db.close();
    const rotated = store(path);
    expect(rotated.password).not.toBe(password);
    expect((await app(rotated.store).request("/api/sessions", { headers: { cookie } })).status).toBe(401);
    rotated.db.close();
  });

  it("is refused when tampered with or expired", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const value = cookie.split("=")[1] ?? "";
    const [expiresAt, sig = ""] = value.split(".");
    for (const forged of [
      `pier_session=${Number(expiresAt) + 60_000}.${sig}`,
      `pier_session=${Date.now() - 1}.${sig}`,
      `pier_session=${expiresAt}.${sig.slice(0, -1)}`,
      "pier_session=nonsense",
      "pier_session=",
    ]) {
      expect((await a.request("/api/sessions", { headers: { cookie: forged } })).status).toBe(401);
    }
  });
});
