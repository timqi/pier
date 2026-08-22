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
  registerAuthRoutes(a, s);
  a.use("*", requireAuth(s));
  a.get("/", (c) => c.text("workbench"));
  a.get("/api/sessions", (c) => c.json([]));
  a.post("/api/sessions", (c) => c.json({ ok: true }));
  a.get("/p/report/", (c) => c.text("published"));
  a.get("/boards/_assets/pier.css", (c) => c.text("css"));
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
    const res = await app(store().store).request("/boards/report/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fboards%2Freport%2F");
  });

  it("refuses a write without redirecting it", async () => {
    const res = await app(store().store).request("/api/sessions", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("serves published boards and their stylesheet to a logged-out visitor", async () => {
    const a = app(store().store);
    expect((await a.request("/p/report/")).status).toBe(200);
    expect((await a.request("/boards/_assets/pier.css")).status).toBe(200);
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
    expect((await a.request("/api/sessions", { headers: { cookie } })).status).toBe(200);
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
    client: string = crypto.randomUUID(),
  ): Promise<Response> =>
    Promise.resolve(a.request("/api/password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": client },
      body: JSON.stringify(body),
    }));

  it("swaps the password, hands back a working cookie, and kills the old ones", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const before = cookieOf(await login(a, password));

    const res = await change(a, { current: password, next: "correct-horse" });
    expect(res.status).toBe(200);
    expect(s.verify("correct-horse")).toBe(true);
    expect(s.verify(password)).toBe(false);

    // The caller keeps working; every cookie signed under the old hash does not.
    const after = cookieOf(res);
    expect((await a.request("/api/sessions", { headers: { cookie: after } })).status).toBe(200);
    expect((await a.request("/api/sessions", { headers: { cookie: before } })).status).toBe(401);
    expect((await login(a, "correct-horse")).status).toBe(302);
  });

  it("refuses the wrong current password, a short new one, and a guessing run", async () => {
    const { store: s, password } = store();
    const a = app(s);

    const wrong = await change(a, { current: "nope", next: "correct-horse" });
    expect(wrong.status).toBe(401);
    const short = await change(a, { current: password, next: "short" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Use at least 10 characters." });
    // Neither attempt changed anything.
    expect(s.verify(password)).toBe(true);

    // Same throttle as login: "change" answers the same guess "sign in" does.
    const client = "10.0.0.11";
    for (let i = 0; i < 10; i++) {
      expect((await change(a, { current: "nope", next: "correct-horse" }, client)).status).toBe(401);
    }
    expect((await change(a, { current: password, next: "correct-horse" }, client)).status).toBe(429);
    expect(s.verify(password)).toBe(true);
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
