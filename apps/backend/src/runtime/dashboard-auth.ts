import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { z } from "zod";
import { dashboardAccessWasConfigured, markDashboardAccessConfigured } from "@raceiq/backend-core/runtime/config/dashboard-access-state";

export const PasswordSchema = z.string().min(8).max(1024);
export const NetworkSchema = z.object({
  hosts: z.array(z.string()).min(1).max(32),
  origins: z.array(z.string()).max(32),
});
export type DashboardNetwork = z.infer<typeof NetworkSchema>;
type AccessRow = { mode: "pending" | "enabled" | "disabled"; password_hash: string | null; revision: number; network_json: string | null; upgrade: number | null };
type Session = { csrf: string; generation: string; expires_at: number };
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class AccessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function availableInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    (values ?? [])
      .filter((value) => value.family === "IPv4" && !value.internal)
      .map((value) => ({ name, address: value.address, tailnet: /^100\./.test(value.address) && Number(value.address.split(".")[1]) >= 64 && Number(value.address.split(".")[1]) <= 127 })),
  );
}

export function validateNetwork(input: DashboardNetwork): DashboardNetwork {
  const network = NetworkSchema.parse(input);
  const available = new Set(["127.0.0.1", "::1", ...availableInterfaces().map((value) => value.address)]);
  for (const host of network.hosts) {
    if (!isIP(host) || !available.has(host)) throw new AccessError("invalid_network");
  }
  for (const origin of network.origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new AccessError("invalid_network");
    }
    if (!["http:", "https:"].includes(url.protocol) || origin !== url.origin || url.username || url.password || url.hostname.includes("*")) throw new AccessError("invalid_network");
  }
  return { hosts: [...new Set(network.hosts)], origins: [...new Set(network.origins)] };
}

/** Uses the application's migrated DB; never creates a missing state row.
 * A deleted row/table or invalid configuration therefore fails closed.
 */
export class DashboardAuth {
  readonly env: NodeJS.ProcessEnv;
  readonly database: Database;
  readonly overrides: string[];
  private readonly envPassword: string;
  private attempts = 0;
  private attemptWindow = 0;
  private activeVerifications = 0;
  private readonly path: string;

  constructor(path: string, env: NodeJS.ProcessEnv = process.env, recovery = false) {
    this.path = path;
    this.env = env;
    this.database = new Database(path, { readwrite: true, create: false });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.envPassword = env.SERVER_PASSWORD || "";
    if (this.envPassword && !PasswordSchema.safeParse(this.envPassword).success) throw new Error("SERVER_PASSWORD must contain at least 8 characters (maximum 1024)");
    this.overrides = ["SERVER_PASSWORD", "SERVER_HOST", "SERVER_ALLOWED_ORIGINS"].filter((key) => !!env[key]);
    if (!recovery) {
      try {
        const row = this.read();
        // Adopt configured installations from the earlier auth draft.
        if (row.mode !== "pending") markDashboardAccessConfigured(this.path);
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
  }

  private read(): AccessRow {
    const row = this.database.query<AccessRow, []>("SELECT mode, password_hash, revision, network_json, upgrade FROM dashboard_access WHERE id = 1").get();
    if (row?.mode === "pending" && dashboardAccessWasConfigured(this.path)) {
      throw new Error("Previously configured dashboard authentication is missing; restore the access configuration from backup");
    }
    if (
      !row ||
      !["pending", "disabled", "enabled"].includes(row.mode) ||
      (row.mode === "enabled" && !row.password_hash?.startsWith("$argon2id$")) ||
      (row.mode !== "enabled" && row.password_hash !== null)
    )
      throw new Error("Dashboard authentication configuration is missing or corrupt; use raceiq auth reset");
    if (row.network_json !== null) {
      const network = NetworkSchema.safeParse(JSON.parse(row.network_json));
      if (
        !network.success ||
        network.data.hosts.some((host) => !isIP(host)) ||
        network.data.origins.some((origin) => {
          try {
            const url = new URL(origin);
            return url.origin !== origin || !["http:", "https:"].includes(url.protocol) || !!url.username || !!url.password || url.hostname.includes("*");
          } catch {
            return true;
          }
        })
      )
        throw new Error("Dashboard network configuration is corrupt");
    } else if (row.mode !== "pending") throw new Error("Dashboard access configuration is missing");
    return row;
  }

  async initialize(upgrade: boolean) {
    const row = this.read();
    if (row.network_json === null) {
      // An intentional one-time migration preserves old all-interface deployments.
      const network: DashboardNetwork = { hosts: [upgrade ? "0.0.0.0" : "127.0.0.1"], origins: [] };
      this.database.query("UPDATE dashboard_access SET network_json = ?, upgrade = ? WHERE id = 1 AND network_json IS NULL").run(JSON.stringify(network), Number(upgrade));
    }
    if (this.envPassword && this.read().mode === "pending") {
      const hash = await Bun.password.hash(this.envPassword, { algorithm: "argon2id" });
      this.database.transaction(() => {
        const changed = this.database.query("UPDATE dashboard_access SET mode = 'enabled', password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending'").run(hash);
        if (changed.changes) markDashboardAccessConfigured(this.path);
      })();
    }
  }

  get network(): DashboardNetwork {
    return JSON.parse(this.read().network_json ?? '{"hosts":["127.0.0.1"],"origins":[]}');
  }
  get pending() {
    return this.read().mode === "pending" && !this.envPassword;
  }
  get protected() {
    return !!this.envPassword || this.read().mode === "enabled";
  }
  private generation(row = this.read()) {
    return digest(`${row.revision}:${this.envPassword}`);
  }

  session(request: Request): Session | null {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token) return null;
    const session = this.database.query<Session, [string]>("SELECT csrf, generation, expires_at FROM dashboard_sessions WHERE token_hash = ?").get(digest(token));
    return session && session.expires_at > Date.now() && session.generation === this.generation() ? session : null;
  }

  status(request: Request) {
    const session = this.session(request);
    return {
      pending: this.pending,
      protected: this.protected,
      authenticated: !this.pending && (!this.protected || !!session),
      csrf: session?.csrf ?? null,
      upgrade: !!this.read().upgrade,
      overrides: this.overrides,
    };
  }

  csrfAllowed(request: Request) {
    const session = this.session(request);
    return !!session && request.headers.get("x-raceiq-csrf") === session.csrf;
  }

  private async verify(password: string) {
    if (password.length > 1024 || this.activeVerifications >= 2) throw new AccessError("try_later", 429);
    if (Date.now() - this.attemptWindow > 60_000) {
      this.attemptWindow = Date.now();
      this.attempts = 0;
    }
    if (++this.attempts > 15) throw new AccessError("try_later", 429);
    const row = this.read();
    this.activeVerifications++;
    try {
      const valid = this.envPassword
        ? timingSafeEqual(Buffer.from(digest(password)), Buffer.from(digest(this.envPassword)))
        : !!row.password_hash && (await Bun.password.verify(password, row.password_hash));
      if (!valid || this.generation(row) !== this.generation()) throw new AccessError("incorrect_password", 401);
      return row.revision;
    } finally {
      this.activeVerifications--;
    }
  }

  issueSession(request: Request, expectedRevision?: number) {
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    this.database.transaction(() => {
      const row = this.read();
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new AccessError("configuration_changed", 409);
      this.database.query("DELETE FROM dashboard_sessions WHERE expires_at <= ?").run(Date.now());
      this.database
        .query("INSERT INTO dashboard_sessions (token_hash, csrf, generation, expires_at) VALUES (?, ?, ?, ?)")
        .run(digest(token), csrf, this.generation(row), Date.now() + SESSION_SECONDS * 1000);
    })();
    const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    return { csrf, cookie: `raceiq_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}` };
  }

  async login(password: string, request: Request) {
    if (this.pending || !this.protected) throw new AccessError("not_available", 409);
    const revision = await this.verify(password);
    return this.issueSession(request, revision);
  }

  logout(request: Request) {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (token) this.database.query("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(digest(token));
    return "raceiq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
  }

  async setup(password: string | null, exposureConfirmed: boolean) {
    if (!this.pending) throw new AccessError("already_configured", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const hash = password === null ? null : await Bun.password.hash(password, { algorithm: "argon2id" });
    this.database.transaction(() => {
      const changed = this.database
        .query("UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending'")
        .run(password === null ? "disabled" : "enabled", hash);
      if (changed.changes !== 1) throw new AccessError("already_configured", 409);
      // Persist the witness before committing the choice. A partial failure
      // remains closed instead of offering first-run setup again.
      markDashboardAccessConfigured(this.path);
    })();
  }

  async changePassword(current: string, password: string | null, exposureConfirmed: boolean) {
    if (this.envPassword) throw new AccessError("environment_override", 409);
    if (this.pending) throw new AccessError("not_available", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const revision = this.protected ? await this.verify(current) : this.read().revision;
    const hash = password === null ? null : await Bun.password.hash(password, { algorithm: "argon2id" });
    this.database.transaction(() => {
      const result = this.database
        .query("UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND revision = ? AND mode != 'pending'")
        .run(password === null ? "disabled" : "enabled", hash, revision);
      if (result.changes !== 1) throw new AccessError("configuration_changed", 409);
      this.database.exec("DELETE FROM dashboard_sessions");
    })();
  }

  saveNetwork(network: DashboardNetwork) {
    const existing = this.network;
    const sameHosts = JSON.stringify(existing.hosts) === JSON.stringify(network.hosts);
    const sameOrigins = JSON.stringify(existing.origins) === JSON.stringify(network.origins);
    if ((this.env.SERVER_HOST && !sameHosts) || (this.env.SERVER_ALLOWED_ORIGINS && !sameOrigins)) throw new AccessError("environment_override", 409);
    const validated = validateNetwork({ ...network, hosts: sameHosts ? ["127.0.0.1"] : network.hosts });
    this.database.query("UPDATE dashboard_access SET network_json = ? WHERE id = 1").run(JSON.stringify({ ...validated, hosts: sameHosts ? existing.hosts : validated.hosts }));
  }

  async reset(password: string) {
    if (this.envPassword) throw new AccessError("environment_override", 409);
    PasswordSchema.parse(password);
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    // Recovery can repair an invalid hash/mode, but never recreates lost network
    // configuration or invents a first-run state.
    this.database.transaction(() => {
      const result = this.database.query("UPDATE dashboard_access SET mode = 'enabled', password_hash = ?, revision = revision + 1 WHERE id = 1 AND network_json IS NOT NULL").run(hash);
      if (result.changes !== 1) throw new AccessError("restore_configuration", 409);
      markDashboardAccessConfigured(this.path);
      this.database.exec("DELETE FROM dashboard_sessions");
    })();
  }
}

let dashboardAuth: DashboardAuth | undefined;
export function setDashboardAuth(auth: DashboardAuth) {
  dashboardAuth = auth;
}
export function getDashboardAuth() {
  if (!dashboardAuth) throw new Error("Dashboard authentication is not initialized");
  return dashboardAuth;
}
