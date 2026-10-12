import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "@raceiq/backend-core/db/migrations";
import { DashboardAuth, setDashboardAuth, validateNetwork } from "../../src/runtime/dashboard-auth";
import { createHttpAccess } from "../../src/runtime/http-access";
import { Hono } from "hono";
import { authRoutes } from "../../src/routes/auth-routes";
import { startHttpServer } from "../../src/runtime/http-server";
import { dashboardAccessMarkerPath } from "@raceiq/backend-core/runtime/config/dashboard-access-state";

function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-dashboard-auth-"));
  const path = join(directory, "app.db");
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  for (const sql of migrations.find((migration) => migration.version === 64)!.sql) db.exec(sql);
  db.close();
  const auth = new DashboardAuth(path, env);
  return {
    auth,
    path,
    close: () => {
      auth.database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const request = (path = "/api/laps", headers: HeadersInit = {}, method = "GET") => new Request(`http://localhost:3117${path}`, { headers, method });
const cookieRequest = (cookie: string, headers: HeadersInit = {}, method = "GET") => request("/api/laps", { cookie: cookie.split(";")[0], ...headers }, method);
// DOM types hide Bun's documented custom-header overload of the global client.
const BunWebSocket = globalThis.WebSocket as unknown as { new (url: string, options: { headers: HeadersInit }): WebSocket };

describe("persistent dashboard authentication", () => {
  test("configured state cannot revert to first-run setup; markers contain no credentials", async () => {
    for (const password of ["abcdefgh", null]) {
      const f = fixture();
      try {
        await f.auth.initialize(false);
        expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(false);
        await f.auth.setup(password, true);
        expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(true);
        f.auth.database.exec("UPDATE dashboard_access SET mode = 'pending', password_hash = NULL, network_json = NULL");
        expect(() => new DashboardAuth(f.path, {})).toThrow("Previously configured");
        await expect(f.auth.setup(null, true)).rejects.toThrow("Previously configured");
      } finally { f.close(); }
    }
  });
  test("existing configured drafts gain a marker, and corrupt markers fail closed", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup(null, true);
      rmSync(dashboardAccessMarkerPath(f.path));
      const upgraded = new DashboardAuth(f.path, {});
      upgraded.database.close();
      expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(true);
      writeFileSync(dashboardAccessMarkerPath(f.path), "corrupt");
      expect(() => new DashboardAuth(f.path, {})).toThrow("marker is corrupt");
    } finally { f.close(); }
  });
  test("saved browser domains preserve localhost access on upgraded wildcard listeners", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup("abcdefgh", false);
      f.auth.database.query("UPDATE dashboard_access SET network_json = ? WHERE id = 1").run(JSON.stringify({ hosts: ["0.0.0.0"], origins: ["http://raceiq.tailnet.ts.net:3117"] }));
      const policy = createHttpAccess({ NODE_ENV: "production" }, f.auth);
      const session = await f.auth.login("abcdefgh", request());
      const cookie = session.cookie.split(";")[0];
      for (const origin of ["http://localhost:3117", "http://127.0.0.1:3117", "http://raceiq.tailnet.ts.net:3117"]) {
        expect(policy.authorize(new Request(`${origin}/`))).toBeUndefined();
        for (const path of ["/api/laps", "/ws"]) {
          expect(policy.authorize(new Request(`${origin}${path}`, { headers: { origin } }))?.status).toBe(401);
          expect(policy.authorize(new Request(`${origin}${path}`, { headers: { origin, cookie } }))).toBeUndefined();
        }
      }
      expect(policy.authorize(request("/ws", { origin: "http://untrusted.example", cookie }))?.status).toBe(403);
      expect(policy.authorize(new Request("http://untrusted.example:3117/"))?.status).toBe(403);
      const restricted = createHttpAccess({ NODE_ENV: "production", SERVER_ALLOWED_ORIGINS: "http://raceiq.tailnet.ts.net:3117" }, f.auth);
      expect(restricted.authorize(request("/"))?.status).toBe(403);
    } finally { f.close(); }
  });
  test("development LAN dashboard origins follow bound addresses without bypassing authentication or explicit allowlists", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup("abcdefgh", false);
      // Use a documentation-only IP without changing real network bindings.
      f.auth.database.query("UPDATE dashboard_access SET network_json = ? WHERE id = 1").run(JSON.stringify({ hosts: ["127.0.0.1", "192.0.2.15"], origins: [] }));
      const policy = createHttpAccess({ NODE_ENV: "development" }, f.auth);
      const session = await f.auth.login("abcdefgh", request());
      for (const path of ["/api/laps", "/ws"]) {
        const url = `http://localhost:3117${path}`;
        const origin = "http://192.0.2.15:4118";
        expect(policy.authorize(new Request(url, { headers: { origin } }))?.status).toBe(401);
        expect(policy.authorize(new Request(url, { headers: { origin, cookie: session.cookie.split(";")[0] } }))).toBeUndefined();
        for (const rejected of ["http://192.0.2.16:4118", "http://192.0.2.15.attacker.example:4118", "null"]) {
          expect(policy.authorize(new Request(url, { headers: { origin: rejected, cookie: session.cookie.split(";")[0] } }))?.status).toBe(403);
        }
        for (const env of [
          { NODE_ENV: "production" },
          { NODE_ENV: "development", SERVER_ALLOWED_ORIGINS: "http://192.0.2.15:3117" },
        ]) {
          expect(createHttpAccess(env, f.auth).authorize(new Request(url, { headers: { origin, cookie: session.cookie.split(";")[0] } }))?.status).toBe(403);
        }
      }
      expect(policy.authorize(cookieRequest(session.cookie, { origin: "http://192.0.2.15:4118" }, "PUT"))?.status).toBe(403);
      expect(policy.authorize(cookieRequest(session.cookie, { origin: "http://192.0.2.15:4118", "x-raceiq-csrf": session.csrf }, "PUT"))).toBeUndefined();
    } finally { f.close(); }
  });
  test("migration preserves the earlier auth draft and does not reopen setup if its configured state was lost", async () => {
    const f = fixture();
    try {
      f.auth.database.query("INSERT INTO schema_migrations (version, name) VALUES (63, ?)").run("persist dashboard access and login sessions");
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      const session = await f.auth.login("abcdefgh", request());
      const migration = migrations.find((value) => value.version === 64)!;
      for (const sql of migration.sql) f.auth.database.exec(sql);
      expect(f.auth.protected).toBe(true);
      expect(f.auth.session(cookieRequest(session.cookie))?.csrf).toBe(session.csrf);
      f.auth.database.exec("DROP TABLE dashboard_access");
      for (const sql of migration.sql) f.auth.database.exec(sql);
      expect(() => new DashboardAuth(f.path, {})).toThrow("missing or corrupt");
    } finally { f.close(); }
  });
  test("password recovery rejects old HTTP sessions and disconnects an already authenticated WebSocket", async () => {
    const f = fixture();
    await f.auth.initialize(true);
    await f.auth.setup("abcdefgh", false);
    const access = createHttpAccess({ NODE_ENV: "production" }, f.auth);
    const server = startHttpServer({
      app: { fetch: () => Response.json({ ok: true }) },
      port: 0,
      staticDir: null,
      devPublicDir: null,
      access: { ...access, hostname: "127.0.0.1" },
    });
    let socket: WebSocket | undefined;
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${url}/api/status`)).status).toBe(401);
      const session = await f.auth.login("abcdefgh", new Request(url));
      const headers = { cookie: session.cookie.split(";")[0] };
      expect((await fetch(`${url}/api/status`, { headers })).status).toBe(200);
      socket = new BunWebSocket(`${url.replace("http:", "ws:")}/ws`, { headers });
      const closed = new Promise<number>((resolve) => {
        socket!.onclose = (event) => resolve(event.code);
      });
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve();
        socket!.onerror = () => reject(new Error("Authenticated WebSocket did not open"));
      });
      const recovery = new DashboardAuth(f.path, {});
      try {
        await recovery.reset("ijklmnop");
      } finally {
        recovery.database.close();
      }
      expect((await fetch(`${url}/api/status`, { headers })).status).toBe(401);
      expect(await Promise.race([closed, Bun.sleep(4000).then(() => -1)])).toBe(1008);
    } finally {
      socket?.close();
      server.stop(true);
      f.close();
    }
  });
  test("HTTP setup/login/password/logout routes enforce state and CSRF without returning credentials", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      setDashboardAuth(f.auth);
      const policy = createHttpAccess({ NODE_ENV: "production" }, f.auth);
      const app = new Hono()
        .use("/*", async (c, next) => {
          const denied = policy.authorize(c.req.raw);
          if (denied) return denied;
          await next();
        })
        .route("/", authRoutes);
      const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
        app.fetch(
          new Request(`http://localhost:3117/api/auth/${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost:3117", ...headers }, body: JSON.stringify(body) }),
        );
      expect((await post("setup", { password: "short", exposureConfirmed: false })).status).toBe(400);
      const setup = await post("setup", { password: "abcdefgh", exposureConfirmed: false, language: "es" });
      expect(setup.status).toBe(200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0];
      const status = await app.fetch(new Request("http://localhost:3117/api/auth/status", { headers: { cookie } }));
      const state = (await status.json()) as { csrf: string; language: string; protected: boolean };
      expect(state.language).toBe("es");
      expect(state.protected).toBe(true);
      expect(JSON.stringify(state)).not.toContain("password_hash");
      expect((await post("setup", { password: null, exposureConfirmed: true })).status).toBe(409);
      expect((await post("login", { password: "wrongpass" })).status).toBe(401);
      expect((await post("password", { currentPassword: "abcdefgh", password: "ijklmnop", exposureConfirmed: false }, { cookie }, "PUT")).status).toBe(403);
      expect((await post("password", { currentPassword: "abcdefgh", password: "ijklmnop", exposureConfirmed: false }, { cookie, "x-raceiq-csrf": state.csrf }, "PUT")).status).toBe(200);
      const login = await post("login", { password: "ijklmnop" });
      expect(login.status).toBe(200);
      const nextCookie = login.headers.get("set-cookie")!.split(";")[0];
      const nextStatus = await app.fetch(new Request("http://localhost:3117/api/auth/status", { headers: { cookie: nextCookie } }));
      const nextState = (await nextStatus.json()) as { csrf: string };
      expect((await post("logout", {}, { cookie: nextCookie, "x-raceiq-csrf": nextState.csrf })).status).toBe(200);
      expect(f.auth.session(request("/ws", { cookie: nextCookie }))).toBeNull();
    } finally {
      f.close();
    }
  });
  test("fresh setup blocks application data, defaults to loopback and saves explicit disabled protection", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      const policy = createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect(policy.hostname).toBe("127.0.0.1");
      for (const path of ["/api/laps", "/api/settings", "/studio-api", "/ws"]) expect(policy.authorize(request(path))?.status).toBe(423);
      expect(policy.authorize(request("/api/auth/status"))).toBeUndefined();
      await expect(f.auth.setup(null, false)).rejects.toThrow("confirm_exposure");
      await f.auth.setup(null, true);
      expect(f.auth.pending).toBe(false);
      expect(f.auth.protected).toBe(false);
      expect(policy.authorize(request())).toBeUndefined();
      const restarted = new DashboardAuth(f.path, {});
      expect(restarted.pending).toBe(false);
      restarted.database.close();
      await expect(f.auth.setup("abcdefgh", false)).rejects.toThrow("already_configured");
    } finally {
      f.close();
    }
  });

  test("only one concurrent visitor can complete setup", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      const outcomes = await Promise.allSettled([f.auth.setup("abcdefgh", false), f.auth.setup("ijklmnop", false)]);
      expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  test("letters-only passwords work; hashes and sessions are salted and durable; writes require CSRF", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      await expect(f.auth.setup("abcdefg", false)).rejects.toThrow("password_length");
      await f.auth.setup("abcdefgh", false);
      const hash = (f.auth.database.query("SELECT password_hash FROM dashboard_access").get() as { password_hash: string }).password_hash;
      expect(hash).toStartWith("$argon2id$");
      expect(hash).not.toContain("abcdefgh");
      const policy = createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect(policy.authorize(request())?.status).toBe(401);
      expect(policy.authorize(request("/ws"))?.status).toBe(401);
      await expect(f.auth.login("wrongpass", request())).rejects.toThrow("incorrect_password");
      const session = await f.auth.login("abcdefgh", request());
      expect(session.cookie).toContain("HttpOnly; SameSite=Strict");
      const authenticated = cookieRequest(session.cookie);
      expect(policy.authorize(authenticated)).toBeUndefined();
      expect(policy.authorize(cookieRequest(session.cookie, {}, "PUT"))?.status).toBe(403);
      expect(policy.authorize(cookieRequest(session.cookie, { "x-raceiq-csrf": session.csrf }, "PUT"))).toBeUndefined();
      expect(policy.authorize(cookieRequest(session.cookie, { origin: "https://attacker.example", "x-raceiq-csrf": session.csrf }, "PUT"))?.status).toBe(403);
      const restarted = new DashboardAuth(f.path, {});
      expect(restarted.session(authenticated)?.csrf).toBe(session.csrf);
      expect(JSON.stringify(restarted.status(authenticated))).not.toContain(hash);
      restarted.database.close();
      f.auth.logout(authenticated);
      expect(policy.authorize(authenticated)?.status).toBe(401);
    } finally {
      f.close();
    }
  });

  test("password changes, disable and CLI recovery invalidate sessions across processes", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      const session = await f.auth.login("abcdefgh", request());
      await expect(f.auth.changePassword("incorrect", null, true)).rejects.toThrow("incorrect_password");
      await f.auth.changePassword("abcdefgh", "ijklmnop", false);
      expect(f.auth.session(cookieRequest(session.cookie))).toBeNull();
      const second = await f.auth.login("ijklmnop", request());
      const recovery = new DashboardAuth(f.path, {});
      await recovery.reset("qrstuvwx");
      recovery.database.close();
      expect(f.auth.session(cookieRequest(second.cookie))).toBeNull();
      await expect(f.auth.changePassword("qrstuvwx", null, false)).rejects.toThrow("confirm_exposure");
      await f.auth.changePassword("qrstuvwx", null, true);
      expect(f.auth.protected).toBe(false);
    } finally {
      f.close();
    }
  });

  test("upgrade retains listener and environment protection without offering first-run setup", async () => {
    const f = fixture({ SERVER_PASSWORD: "abcdefgh", SERVER_HOST: "0.0.0.0" });
    try {
      await f.auth.initialize(true);
      expect(f.auth.network.hosts).toEqual(["0.0.0.0"]);
      expect(f.auth.pending).toBe(false);
      expect(f.auth.protected).toBe(true);
      expect(f.auth.overrides).toContain("SERVER_PASSWORD");
      await expect(f.auth.setup(null, true)).rejects.toThrow("already_configured");
      await expect(f.auth.changePassword("abcdefgh", null, true)).rejects.toThrow("environment_override");
      const withoutOverride = new DashboardAuth(f.path, {});
      expect(withoutOverride.protected).toBe(true);
      await withoutOverride.login("abcdefgh", request());
      withoutOverride.database.close();
    } finally {
      f.close();
    }
  });

  test("lost/corrupt configured state fails closed and recovery repairs a corrupt password", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      f.auth.database.exec("UPDATE dashboard_access SET password_hash = NULL");
      expect(() => new DashboardAuth(f.path, {})).toThrow("missing or corrupt");
      const recovery = new DashboardAuth(f.path, {}, true);
      await recovery.reset("abcdefgh");
      recovery.database.close();
      expect(f.auth.protected).toBe(true);
      f.auth.database.exec("DELETE FROM dashboard_access");
      expect(() => f.auth.status(request())).toThrow("missing or corrupt");
      const missing = new DashboardAuth(f.path, {}, true);
      await expect(missing.reset("abcdefgh")).rejects.toThrow("restore_configuration");
      missing.database.close();
    } finally {
      f.close();
    }
  });

  test("network choices do not change auth or include unselected interfaces", async () => {
    const f = fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup(null, true);
      expect(() => validateNetwork({ hosts: ["0.0.0.0"], origins: [] })).toThrow();
      expect(() => validateNetwork({ hosts: ["127.0.0.1"], origins: ["https://example.com/path"] })).toThrow();
      f.auth.saveNetwork({ hosts: ["127.0.0.1"], origins: ["https://raceiq.example.com", "http://raceiq.tailnet.ts.net:3117"] });
      expect(f.auth.protected).toBe(false);
      expect(f.auth.network.hosts).toEqual(["127.0.0.1"]);
      const access = createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect(access.authorize(request("/ws", { origin: "https://raceiq.example.com" }))).toBeUndefined();
      expect(access.authorize(request("/ws", { origin: "https://attacker.example" }))?.status).toBe(403);
      expect(access.authorize(new Request("http://attacker.example:3117/api/laps"))?.status).toBe(403);
    } finally {
      f.close();
    }
  });
});
