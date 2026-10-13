import { afterAll, describe, expect, test as bunTest } from "bun:test";
import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrations } from "@raceiq/backend-core/db/migrations";
import { DashboardAuth, setDashboardAuth, validateNetwork } from "../../src/runtime/dashboard-auth";
import { createHttpAccess } from "../../src/runtime/http-access";
import { Hono } from "hono";
import { authRoutes } from "../../src/routes/auth-routes";
import { startHttpServer } from "../../src/runtime/http-server";
import { dashboardAccessMarkerPath } from "@raceiq/backend-core/runtime/config/dashboard-access-state";
import { client as applicationDb } from "@raceiq/backend-core/db/index";
import type { WSData } from "@raceiq/backend-core/runtime/websocket-manager";

// The parent owns fixture files; only child processes open their databases.
// libSQL close() can leave native handles alive until process exit on Windows.
function test(name: string, scenario: () => Promise<void>) {
  if (process.env.RACEIQ_AUTH_CASE) {
    if (process.env.RACEIQ_AUTH_CASE === name) bunTest(name, scenario);
    return;
  }
  bunTest(name, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-dashboard-auth-"));
    try {
      const config = join(directory, "bunfig.toml");
      writeFileSync(config, `[test]\nroot = ${JSON.stringify(directory.replaceAll("\\", "/"))}\npreload = []\ntimeout = 10000\n`);
      const child = Bun.spawn([process.execPath, "test", `--config=${config}`, import.meta.path], {
        env: {
          ...process.env,
          DATA_DIR: directory,
          RACEIQ_TEST_DATA_DIR: directory,
          RACEIQ_TEST_MODE: "1",
          DB_IN_MEMORY: "0",
          SERVER_PASSWORD: "",
          RACEIQ_AUTH_CASE: name,
          RACEIQ_AUTH_FIXTURE_DIR: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // A watchdog bounds a hung native subprocess; successful runs await exit,
      // never a fixed delay. Fake timers cannot terminate another process.
      const deadline = setTimeout(() => child.kill(), 15000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`Authentication scenario failed (${code}):\n${stdout}\n${stderr}`);
      } finally {
        clearTimeout(deadline);
        child.kill();
        await child.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20000);
}

if (process.env.RACEIQ_AUTH_CASE) afterAll(() => applicationDb.close());

async function recoverPassword(path: string, password: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/reset-dashboard-password.ts")], {
    env: {
      ...process.env,
      DATA_DIR: dirname(path),
      RACEIQ_TEST_MODE: "0",
      SERVER_PASSWORD: "",
      RACEIQ_AUTH_RECOVERY_PASSWORD: password,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Bound a hung command process; completion itself is signaled by child.exited.
  const deadline = setTimeout(() => child.kill(), 10000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Password recovery command failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
}

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(process.env.RACEIQ_AUTH_FIXTURE_DIR!, "fixture-"));
  const path = join(directory, "app.db");
  const db = createClient({ url: `file:${path}` });
  try {
    await db.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    for (const sql of migrations.find((migration) => migration.name === "persist dashboard access and login sessions")!.sql) await db.execute(sql);
    const auth = await DashboardAuth.create(db, path, env);
    return { auth, db, path, close: async () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
const request = (path = "/api/laps", headers: HeadersInit = {}, method = "GET") => new Request(`http://localhost:3117${path}`, { headers, method });
const cookieRequest = (cookie: string, headers: HeadersInit = {}, method = "GET") => request("/api/laps", { cookie: cookie.split(";")[0], ...headers }, method);
// DOM types hide Bun's documented custom-header overload of the global client.
const BunWebSocket = globalThis.WebSocket as unknown as { new (url: string, options: { headers: HeadersInit }): WebSocket };

describe("persistent dashboard authentication", () => {
  test("configured state cannot revert to first-run setup; markers contain no credentials", async () => {
    for (const password of ["abcdefgh", null]) {
      const f = await fixture();
      try {
        await f.auth.initialize(false);
        expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(false);
        await f.auth.setup(password, true);
        expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(true);
        await f.db.execute("UPDATE dashboard_access SET mode = 'pending', password_hash = NULL, network_json = NULL");
        await expect(DashboardAuth.create(f.db, f.path, {})).rejects.toThrow("Previously configured");
        await expect(f.auth.setup(null, true)).rejects.toThrow("Previously configured");
      } finally {
        await f.close();
      }
    }
  });
  test("existing configured drafts gain a marker, and corrupt markers fail closed", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup(null, true);
      rmSync(dashboardAccessMarkerPath(f.path));
      await DashboardAuth.create(f.db, f.path, {});
      expect(existsSync(dashboardAccessMarkerPath(f.path))).toBe(true);
      writeFileSync(dashboardAccessMarkerPath(f.path), "corrupt");
      await expect(DashboardAuth.create(f.db, f.path, {})).rejects.toThrow("marker is corrupt");
    } finally {
      await f.close();
    }
  });
  test("saved browser domains preserve localhost access on upgraded wildcard listeners", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup("abcdefgh", false);
      await f.db.execute({ sql: "UPDATE dashboard_access SET network_json = ? WHERE id = 1", args: [JSON.stringify({ hosts: ["0.0.0.0"], origins: ["http://raceiq.tailnet.ts.net:3117"] })] });
      const policy = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      const session = await f.auth.login("abcdefgh", request());
      const cookie = session.cookie.split(";")[0];
      for (const origin of ["http://localhost:3117", "http://127.0.0.1:3117", "http://raceiq.tailnet.ts.net:3117"]) {
        expect(await policy.authorize(new Request(`${origin}/`))).toBeUndefined();
        for (const path of ["/api/laps", "/ws"]) {
          expect((await policy.authorize(new Request(`${origin}${path}`, { headers: { origin } })))?.status).toBe(401);
          expect(await policy.authorize(new Request(`${origin}${path}`, { headers: { origin, cookie } }))).toBeUndefined();
        }
      }
      expect((await policy.authorize(request("/ws", { origin: "http://untrusted.example", cookie })))?.status).toBe(403);
      expect((await policy.authorize(new Request("http://untrusted.example:3117/")))?.status).toBe(403);
      const restricted = await createHttpAccess({ NODE_ENV: "production", SERVER_ALLOWED_ORIGINS: "http://raceiq.tailnet.ts.net:3117" }, f.auth);
      expect((await restricted.authorize(request("/")))?.status).toBe(403);
    } finally {
      await f.close();
    }
  });
  test("development LAN dashboard origins follow bound addresses without bypassing authentication or explicit allowlists", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(true);
      await f.auth.setup("abcdefgh", false);
      // Use a documentation-only IP without changing real network bindings.
      await f.db.execute({ sql: "UPDATE dashboard_access SET network_json = ? WHERE id = 1", args: [JSON.stringify({ hosts: ["127.0.0.1", "192.0.2.15"], origins: [] })] });
      const policy = await createHttpAccess({ NODE_ENV: "development" }, f.auth);
      const session = await f.auth.login("abcdefgh", request());
      for (const path of ["/api/laps", "/ws"]) {
        const url = `http://localhost:3117${path}`;
        const origin = "http://192.0.2.15:4118";
        expect((await policy.authorize(new Request(url, { headers: { origin } })))?.status).toBe(401);
        expect(await policy.authorize(new Request(url, { headers: { origin, cookie: session.cookie.split(";")[0] } }))).toBeUndefined();
        for (const rejected of ["http://192.0.2.16:4118", "http://192.0.2.15.attacker.example:4118", "null"]) {
          expect((await policy.authorize(new Request(url, { headers: { origin: rejected, cookie: session.cookie.split(";")[0] } })))?.status).toBe(403);
        }
        for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "development", SERVER_ALLOWED_ORIGINS: "http://192.0.2.15:3117" }]) {
          expect((await (await createHttpAccess(env, f.auth)).authorize(new Request(url, { headers: { origin, cookie: session.cookie.split(";")[0] } })))?.status).toBe(403);
        }
      }
      expect((await policy.authorize(cookieRequest(session.cookie, { origin: "http://192.0.2.15:4118" }, "PUT")))?.status).toBe(403);
      expect(await policy.authorize(cookieRequest(session.cookie, { origin: "http://192.0.2.15:4118", "x-raceiq-csrf": session.csrf }, "PUT"))).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  test("migration preserves the earlier auth draft and does not reopen setup if its configured state was lost", async () => {
    const f = await fixture();
    try {
      await f.db.execute({ sql: "INSERT INTO schema_migrations (version, name) VALUES (63, ?)", args: ["persist dashboard access and login sessions"] });
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      const session = await f.auth.login("abcdefgh", request());
      const migration = migrations.find((value) => value.name === "persist dashboard access and login sessions")!;
      for (const sql of migration.sql) await f.db.execute(sql);
      expect(await f.auth.isProtected()).toBe(true);
      expect((await f.auth.session(cookieRequest(session.cookie)))?.csrf).toBe(session.csrf);
      await f.db.execute("DROP TABLE dashboard_access");
      for (const sql of migration.sql) await f.db.execute(sql);
      await expect(DashboardAuth.create(f.db, f.path, {})).rejects.toThrow("missing or corrupt");
    } finally {
      await f.close();
    }
  });
  test("password recovery rejects old HTTP sessions and disconnects an already authenticated WebSocket", async () => {
    const f = await fixture();
    let server: Bun.Server<WSData> | undefined;
    let socket: WebSocket | undefined;
    try {
      await f.auth.initialize(true);
      await f.auth.setup("abcdefgh", false);
      const access = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      server = startHttpServer({
        app: { fetch: () => Response.json({ ok: true }) },
        port: 0,
        staticDir: null,
        devPublicDir: null,
        access: { ...access, hostname: "127.0.0.1" },
      });
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
      await recoverPassword(f.path, "ijklmnop");
      expect((await fetch(`${url}/api/status`, { headers })).status).toBe(401);
      // Live server must observe cross-process session invalidation and close this socket.
      expect(await closed).toBe(1008);
    } finally {
      socket?.close();
      await server?.stop(true);
      await f.close();
    }
  });
  test("HTTP setup/login/password/logout routes enforce state and CSRF without returning credentials", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      setDashboardAuth(f.auth);
      const policy = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      const app = new Hono()
        .use("/*", async (c, next) => {
          const denied = await policy.authorize(c.req.raw);
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
      expect(await f.auth.session(request("/ws", { cookie: nextCookie }))).toBeNull();
    } finally {
      await f.close();
    }
  });
  test("fresh setup blocks application data, defaults to loopback and saves explicit disabled protection", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      const policy = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect(policy.hostname).toBe("127.0.0.1");
      for (const path of ["/api/laps", "/api/settings", "/studio-api", "/ws"]) expect((await policy.authorize(request(path)))?.status).toBe(423);
      expect(await policy.authorize(request("/api/auth/status"))).toBeUndefined();
      await expect(f.auth.setup(null, false)).rejects.toThrow("confirm_exposure");
      await f.auth.setup(null, true);
      expect(await f.auth.isPending()).toBe(false);
      expect(await f.auth.isProtected()).toBe(false);
      expect(await policy.authorize(request())).toBeUndefined();
      expect(await (await DashboardAuth.create(f.db, f.path, {})).isPending()).toBe(false);
      await expect(f.auth.setup("abcdefgh", false)).rejects.toThrow("already_configured");
    } finally {
      await f.close();
    }
  });

  test("only one concurrent visitor can complete setup", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      const outcomes = await Promise.allSettled([f.auth.setup("abcdefgh", false), f.auth.setup("ijklmnop", false)]);
      expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  test("letters-only passwords work; hashes and sessions are salted and durable; writes require CSRF", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      await expect(f.auth.setup("abcdefg", false)).rejects.toThrow("password_length");
      await f.auth.setup("abcdefgh", false);
      const hashResult = await f.db.execute("SELECT password_hash FROM dashboard_access");
      const hash = hashResult.rows[0]!.password_hash as string;
      expect(hash).toStartWith("$argon2id$");
      expect(hash).not.toContain("abcdefgh");
      const policy = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect((await policy.authorize(request()))?.status).toBe(401);
      expect((await policy.authorize(request("/ws")))?.status).toBe(401);
      await expect(f.auth.login("wrongpass", request())).rejects.toThrow("incorrect_password");
      const session = await f.auth.login("abcdefgh", request());
      expect(session.cookie).toContain("HttpOnly; SameSite=Strict");
      const authenticated = cookieRequest(session.cookie);
      expect(await policy.authorize(authenticated)).toBeUndefined();
      expect((await policy.authorize(cookieRequest(session.cookie, {}, "PUT")))?.status).toBe(403);
      expect(await policy.authorize(cookieRequest(session.cookie, { "x-raceiq-csrf": session.csrf }, "PUT"))).toBeUndefined();
      expect((await policy.authorize(cookieRequest(session.cookie, { origin: "https://attacker.example", "x-raceiq-csrf": session.csrf }, "PUT")))?.status).toBe(403);
      const restartedDb = createClient({ url: `file:${f.path}` });
      try {
        const restarted = await DashboardAuth.create(restartedDb, f.path, {});
        expect((await restarted.session(authenticated))?.csrf).toBe(session.csrf);
        expect(JSON.stringify(await restarted.status(authenticated))).not.toContain(hash);
      } finally {
        await restartedDb.close();
      }
      await f.auth.logout(authenticated);
      expect((await policy.authorize(authenticated))?.status).toBe(401);
    } finally {
      await f.close();
    }
  });

  test("password changes, disable and CLI recovery invalidate sessions across processes", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      const session = await f.auth.login("abcdefgh", request());
      await expect(f.auth.changePassword("incorrect", null, true)).rejects.toThrow("incorrect_password");
      await f.auth.changePassword("abcdefgh", "ijklmnop", false);
      expect(await f.auth.session(cookieRequest(session.cookie))).toBeNull();
      const second = await f.auth.login("ijklmnop", request());
      await recoverPassword(f.path, "qrstuvwx");
      expect(await f.auth.session(cookieRequest(second.cookie))).toBeNull();
      await expect(f.auth.login("ijklmnop", request())).rejects.toThrow("incorrect_password");
      const recovered = await f.auth.login("qrstuvwx", request());
      expect((await f.auth.session(cookieRequest(recovered.cookie)))?.csrf).toBe(recovered.csrf);
      await expect(f.auth.changePassword("qrstuvwx", null, false)).rejects.toThrow("confirm_exposure");
      await f.auth.changePassword("qrstuvwx", null, true);
      expect(await f.auth.isProtected()).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("upgrade retains listener and environment protection without offering first-run setup", async () => {
    const f = await fixture({ SERVER_PASSWORD: "abcdefgh", SERVER_HOST: "0.0.0.0" });
    try {
      await f.auth.initialize(true);
      expect((await f.auth.getNetwork()).hosts).toEqual(["0.0.0.0"]);
      expect(await f.auth.isPending()).toBe(false);
      expect(await f.auth.isProtected()).toBe(true);
      expect(f.auth.overrides).toContain("SERVER_PASSWORD");
      await expect(f.auth.setup(null, true)).rejects.toThrow("already_configured");
      await expect(f.auth.changePassword("abcdefgh", null, true)).rejects.toThrow("environment_override");
      const withoutOverride = await DashboardAuth.create(f.db, f.path, {});
      expect(await withoutOverride.isProtected()).toBe(true);
      await withoutOverride.login("abcdefgh", request());
    } finally {
      await f.close();
    }
  });

  test("lost/corrupt configured state fails closed and recovery repairs a corrupt password", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      await f.db.execute("UPDATE dashboard_access SET password_hash = NULL");
      await expect(DashboardAuth.create(f.db, f.path, {})).rejects.toThrow("missing or corrupt");
      const recoveryDb = createClient({ url: `file:${f.path}` });
      try {
        await (await DashboardAuth.create(recoveryDb, f.path, {}, true)).reset("abcdefgh");
      } finally {
        await recoveryDb.close();
      }
      expect(await f.auth.isProtected()).toBe(true);
      await f.db.execute("DELETE FROM dashboard_access");
      await expect(f.auth.status(request())).rejects.toThrow("missing or corrupt");
      const missingDb = createClient({ url: `file:${f.path}` });
      try {
        const missing = await DashboardAuth.create(missingDb, f.path, {}, true);
        await expect(missing.reset("abcdefgh")).rejects.toThrow("restore_configuration");
      } finally {
        await missingDb.close();
      }
    } finally {
      await f.close();
    }
  });

  test("network choices do not change auth or include unselected interfaces", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup(null, true);
      expect(() => validateNetwork({ hosts: ["0.0.0.0"], origins: [] })).toThrow();
      expect(() => validateNetwork({ hosts: ["127.0.0.1"], origins: ["https://example.com/path"] })).toThrow();
      await f.auth.saveNetwork({ hosts: ["127.0.0.1"], origins: ["https://raceiq.example.com", "http://raceiq.tailnet.ts.net:3117"] });
      expect(await f.auth.isProtected()).toBe(false);
      expect((await f.auth.getNetwork()).hosts).toEqual(["127.0.0.1"]);
      const access = await createHttpAccess({ NODE_ENV: "production" }, f.auth);
      expect(await access.authorize(request("/ws", { origin: "https://raceiq.example.com" }))).toBeUndefined();
      expect((await access.authorize(request("/ws", { origin: "https://attacker.example" })))?.status).toBe(403);
      expect((await access.authorize(new Request("http://attacker.example:3117/api/laps")))?.status).toBe(403);
    } finally {
      await f.close();
    }
  });

  test("concurrent logins reserve verification capacity before reading credentials and release it afterward", async () => {
    const f = await fixture();
    try {
      await f.auth.initialize(false);
      await f.auth.setup("abcdefgh", false);
      const results = await Promise.allSettled([f.auth.login("abcdefgh", request()), f.auth.login("abcdefgh", request()), f.auth.login("abcdefgh", request())]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
      expect(results[2]).toMatchObject({ reason: { code: "try_later", status: 429 } });
      for (const result of results) {
        if (result.status === "fulfilled") {
          expect((await f.auth.session(cookieRequest(result.value.cookie)))?.csrf).toBe(result.value.csrf);
        }
      }
      const next = await f.auth.login("abcdefgh", request());
      expect((await f.auth.session(cookieRequest(next.cookie)))?.csrf).toBe(next.csrf);
    } finally {
      await f.close();
    }
  });
});
