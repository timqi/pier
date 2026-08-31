import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ALL, AuthStore, requireAuth, registerAuthRoutes, upgradeAuthorized } from "./auth.js";

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
  a.get("/p/_assets/pier.css", (c) => c.text("css"));
  a.all("/p/_assets/pier.css", (c) => c.text("css write"));
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
    for (const path of ["/p/report/", "/p/_assets/pier.css"]) {
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

describe("WebSocket auth", () => {
  const upgrade = (
    cookie: string,
    origin?: string,
    host = "pier.example",
    remoteAddress = "127.0.0.1",
    forwardedHost?: string,
  ): IncomingMessage => ({
    headers: { cookie, origin, host, ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}) },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;

  it("uses the HTTP boundary's cookie and normalized Origin rules", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    // The session id comes back, so the socket knows what revoking it means.
    const id = s.list()[0]?.id;
    expect(upgradeAuthorized(s, upgrade(cookie, "https://pier.example"))).toBe(id);
    expect(upgradeAuthorized(s, upgrade(cookie))).toBe(id); // non-browser client
    expect(upgradeAuthorized(s, upgrade("pier_session=bad", "https://pier.example")))
      .toBeUndefined();
    expect(upgradeAuthorized(s, upgrade(cookie, "https://other.example"))).toBeUndefined();
    // A loopback TLS proxy's external host is trusted and URL-normalized.
    expect(upgradeAuthorized(
      s,
      upgrade(cookie, "https://pier.example", "127.0.0.1:3141", "::1", "PIER.EXAMPLE:443"),
    )).toBe(id);
    // A remote caller cannot make its own forwarded host authoritative.
    expect(upgradeAuthorized(
      s,
      upgrade(cookie, "https://pier.example", "127.0.0.1:3141", "10.0.0.2", "pier.example"),
    )).toBeUndefined();
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
    expect(cookie).toMatch(/^pier_session=[\w-]+\.[\w-]{43}$/);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    // A week, not a quarter: the window a stolen cookie is good for.
    expect(res.headers.get("set-cookie")).toContain("Max-Age=604800");
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
    const other = cookieOf(await login(a, password));
    const revoked: string[] = [];
    s.onRevoke((id) => revoked.push(id));

    const res = await change(a, { current: password, next: "correct-horse" }, before);
    expect(res.status).toBe(200);
    expect(s.verify("correct-horse")).toBe(true);
    expect(s.verify(password)).toBe(false);
    expect(revoked).toEqual([ALL]);
    expect(s.list()).toEqual([]);
    expect((await a.request("/api/sessions", { headers: { cookie: other } })).status).toBe(401);

    // No cookie is re-issued — the caller's is cleared, and every session row
    // is gone. Everyone signs in again.
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
  it("clears the cookie and revokes the session behind it", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const res = await a.request("/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toBe("pier_session=");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    // A copy of the cookie taken before signing out is dead too — the row is
    // what authenticates, not the value.
    expect((await a.request("/api/sessions", { headers: { cookie } })).status).toBe(401);
    expect(s.list()).toEqual([]);
  });

  it("is behind the boundary like every other write", async () => {
    const res = await app(store().store).request("/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("the cookie", () => {
  it("survives a restart, and dies when its row is gone", async () => {
    const { store: s, password, path, db } = store();
    const cookie = cookieOf(await login(app(s), password));
    db.close();

    // The session is in the database, so the process may go and come back.
    const restarted = store(path);
    expect((await app(restarted.store).request("/api/sessions", { headers: { cookie } })).status)
      .toBe(200);
    restarted.store.revoke(cookie.split("=")[1]?.split(".")[0] ?? "");
    expect((await app(restarted.store).request("/api/sessions", { headers: { cookie } })).status)
      .toBe(401);
    restarted.db.close();
  });

  it("does not survive the documented password recovery", async () => {
    const { store: s, password, path, db } = store();
    const cookie = cookieOf(await login(app(s), password));

    // "DELETE FROM auth, then restart" is how a lost password is replaced — so
    // it is also how a browser signed in under the old one is put out.
    db.exec("DELETE FROM auth");
    db.close();
    const recovered = store(path);
    expect(recovered.password).not.toBe(password);
    expect(recovered.store.list()).toEqual([]);
    expect((await app(recovered.store).request("/api/sessions", { headers: { cookie } })).status)
      .toBe(401);
    recovered.db.close();
  });

  it("is swept at boot when it expired while Pier was down", async () => {
    const { store: s, password, path, db } = store();
    await login(app(s), password);
    db.prepare("UPDATE web_sessions SET seen_at = ?").run(Date.now() - 8 * 24 * 60 * 60_000);
    db.close();

    // Nothing else would look: the browser never comes back, and until
    // somebody signs in there is no other reason to read this table.
    const restarted = store(path);
    expect(restarted.store.list()).toEqual([]);
    expect(restarted.db.prepare("SELECT count(*) AS n FROM web_sessions").get()).toEqual({ n: 0 });
    restarted.db.close();
  });

  it("is marked Secure only when the request really arrived over TLS", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const proxied = (remoteAddress: string) =>
      a.request("http://127.0.0.1:3141/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-proto": "https",
          "x-forwarded-for": crypto.randomUUID(),
        },
        body: new URLSearchParams({ password, next: "/" }),
      }, { incoming: { socket: { remoteAddress, remotePort: 443, remoteFamily: "IPv4" } } });

    // A local TLS proxy is believed; a stranger writing the same header is not,
    // or anyone could decide this flag for a cookie they are about to receive.
    expect((await proxied("127.0.0.1")).headers.get("set-cookie")).toContain("Secure");
    expect((await proxied("10.0.0.4")).headers.get("set-cookie")).not.toContain("Secure");
    // Pier's own TLS needs no header at all.
    const direct = await a.request("https://pier.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, next: "/" }),
    });
    expect(direct.headers.get("set-cookie")).toContain("Secure");
  });

  it("is refused when tampered with or expired", async () => {
    const { store: s, password, db } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const [id = "", token = ""] = (cookie.split("=")[1] ?? "").split(".");
    for (const forged of [
      `pier_session=${id}.${token.slice(0, -1)}`,
      `pier_session=${id}.`,
      `pier_session=${token}.${token}`,
      "pier_session=nonsense",
      "pier_session=",
    ]) {
      expect((await a.request("/api/sessions", { headers: { cookie: forged } })).status).toBe(401);
    }
    // Still live — none of the above touched the row.
    expect((await a.request("/api/sessions", { headers: { cookie } })).status).toBe(200);

    // A row unused for longer than the TTL is refused without anything having
    // to delete it: last use is the deadline.
    db.prepare("UPDATE web_sessions SET seen_at = ?").run(Date.now() - 8 * 24 * 60 * 60_000);
    expect((await a.request("/api/sessions", { headers: { cookie } })).status).toBe(401);
    db.close();
  });

  it("stores no usable credential: a copy of the database cannot sign anything", async () => {
    const { store: s, password, db } = store();
    const cookie = cookieOf(await login(app(s), password));
    const token = (cookie.split("=")[1] ?? "").split(".")[1] ?? "";
    const row = db.prepare("SELECT token_hash AS h FROM web_sessions").get() as { h: string };
    expect(token).toHaveLength(43); // 32 random bytes, base64url
    expect(row.h).toHaveLength(64);
    expect(row.h).not.toContain(token);
    db.close();
  });

  it("slides its deadline forward on use, on both sides", async () => {
    const { store: s, password, db } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const deadline = () =>
      (db.prepare("SELECT seen_at AS e FROM web_sessions").get() as { e: number }).e;
    const first = deadline();

    // Inside the touch window nothing is written and no cookie is re-sent: one
    // write per browser per five minutes, not one per request.
    const quiet = await a.request("/api/sessions", { headers: { cookie } });
    expect(quiet.headers.get("set-cookie")).toBeNull();
    expect(deadline()).toBe(first);

    // Six minutes later the row and the browser both get the new deadline.
    db.prepare("UPDATE web_sessions SET seen_at = ?").run(Date.now() - 6 * 60_000);
    const used = await a.request("/api/sessions", { headers: { cookie } });
    expect(used.status).toBe(200);
    expect(cookieOf(used)).toBe(cookie);
    expect(used.headers.get("set-cookie")).toContain("Max-Age=604800");
    expect(deadline()).toBeGreaterThan(first);
    db.close();
  });
});

describe("signed-in devices", () => {
  const devices = async (a: Hono, cookie: string) => {
    const res = await a.request("/api/devices", { headers: { cookie } });
    return (await res.json()) as { id: string; ip: string; agent: string; current: boolean }[];
  };

  it("lists every browser, says which one is asking, and signs one out", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const mine = cookieOf(await login(a, password, "10.0.0.20"));
    const other = cookieOf(await login(a, password, "10.0.0.21"));

    const listed = await devices(a, mine);
    expect(listed).toHaveLength(2);
    expect(listed.filter((d) => d.current)).toHaveLength(1);
    expect(listed.map((d) => d.ip).sort()).toEqual(["10.0.0.20", "10.0.0.21"]);

    const victim = listed.find((d) => !d.current)?.id ?? "";
    const res = await a.request(`/api/devices/${victim}/signout`, {
      method: "POST",
      headers: { cookie: mine },
    });
    expect(res.status).toBe(200);
    // The other browser is out; this one is untouched.
    expect((await a.request("/api/sessions", { headers: { cookie: other } })).status).toBe(401);
    expect((await a.request("/api/sessions", { headers: { cookie: mine } })).status).toBe(200);
    expect(await devices(a, mine)).toHaveLength(1);
  });

  it("replaces this browser's row when it signs in again", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const first = cookieOf(await login(a, password));
    const again = await a.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.0.0.22",
        cookie: first,
      },
      body: new URLSearchParams({ password, next: "/" }),
    });
    // One row, not two — and the cookie that was displaced is dead, rather than
    // good for another week as a device nobody recognizes.
    expect(s.list()).toHaveLength(1);
    expect((await a.request("/api/sessions", { headers: { cookie: first } })).status).toBe(401);
    expect((await a.request("/api/sessions", { headers: { cookie: cookieOf(again) } })).status)
      .toBe(200);
  });

  it("refuses the wildcard, and the whole surface without a cookie", async () => {
    const { store: s, password } = store();
    const a = app(s);
    const cookie = cookieOf(await login(a, password));
    const wildcard = await a.request(`/api/devices/${encodeURIComponent(ALL)}/signout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(wildcard.status).toBe(400);
    expect(s.list()).toHaveLength(1);
    expect((await a.request("/api/devices")).status).toBe(401);
  });
});
