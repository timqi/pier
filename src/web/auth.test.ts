import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AuthStore, requireAuth, registerAuthRoutes } from "./auth.js";

/** A store on a throwaway file, plus the password it printed on first boot. */
function store(path = join(mkdtempSync(join(tmpdir(), "pier-auth-")), "pier.db")): {
  store: AuthStore;
  password: string;
  path: string;
} {
  let printed = "";
  const s = new AuthStore(path, (m) => {
    printed = m;
  });
  return { store: s, password: printed.match(/[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}/)?.[0] ?? "", path };
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
    const { store: s, password, path } = store();
    expect(password).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(s.verify(password)).toBe(true);
    expect(s.verify("wrong")).toBe(false);

    // A restart reuses it, and says nothing.
    s.close();
    const again = store(path);
    expect(again.password).toBe("");
    expect(again.store.verify(password)).toBe(true);
    again.store.close();
  });

  it("stores no plaintext, and keeps the database to its owner", () => {
    const { store: s, password, path } = store();
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT salt, hash FROM auth WHERE id = 1").get() as {
      salt: string;
      hash: string;
    };
    expect(row.hash).not.toContain(password);
    expect(row.hash).toHaveLength(64);
    expect(row.salt).toHaveLength(32);
    db.close();
    // The sidecars too: the row is written to the -wal file before any
    // checkpoint, so leaving it 0644 would leak what the database hides.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    s.close();
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

describe("the cookie", () => {
  it("dies with the password it was signed under", async () => {
    const { store: s, password, path } = store();
    const cookie = cookieOf(await login(app(s), password));
    s.close();

    // Rotation, the way an operator does it: drop the row, restart, new password.
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM auth");
    db.close();
    const rotated = store(path);
    expect(rotated.password).not.toBe(password);
    expect((await app(rotated.store).request("/api/sessions", { headers: { cookie } })).status).toBe(401);
    rotated.store.close();
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
