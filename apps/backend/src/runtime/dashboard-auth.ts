import type { Client, Transaction } from "@libsql/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { z } from "zod";
import { dashboardAccessWasConfigured, markDashboardAccessConfigured } from "@raceiq/backend-core/runtime/config/dashboard-access-state";

export const PasswordSchema = z.string().min(8).max(1024);
export const NetworkSchema = z.object({
  hosts: z.array(z.string()).min(1).max(32),
  origins: z.array(z.string()).max(32),
  originsEnabled: z.boolean().default(false),
});
export type DashboardNetwork = z.output<typeof NetworkSchema>;
export type DashboardNetworkInput = z.input<typeof NetworkSchema>;
export interface DashboardInterface {
  name: string;
  address: string;
  tailnet: boolean;
}
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

export function availableInterfaces(): DashboardInterface[] {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    (values ?? [])
      .filter((value) => value.family === "IPv4" && !value.internal)
      .map((value) => ({ name, address: value.address, tailnet: /^100\./.test(value.address) && Number(value.address.split(".")[1]) >= 64 && Number(value.address.split(".")[1]) <= 127 })),
  );
}

export function validateNetwork(input: DashboardNetworkInput): DashboardNetwork {
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
  return { hosts: [...new Set(network.hosts)], origins: [...new Set(network.origins)], originsEnabled: network.originsEnabled };
}

/** Uses the application's migrated DB; never creates or owns a connection. */
export class DashboardAuth {
  readonly env: NodeJS.ProcessEnv;
  readonly overrides: string[];
  private readonly envPassword: string;
  private attempts = 0;
  private attemptWindow = 0;
  private activeHashings = 0;
  private activeVerifications = 0;
  private readonly path: string;
  private readonly database: Client;
  private constructor(database: Client, path: string, env: NodeJS.ProcessEnv) {
    this.path = path;
    this.database = database;
    this.env = env;
    this.envPassword = env.SERVER_PASSWORD || "";
    if (this.envPassword && !PasswordSchema.safeParse(this.envPassword).success) throw new Error("SERVER_PASSWORD must contain at least 8 characters (maximum 1024)");
    this.overrides = ["SERVER_PASSWORD", "SERVER_HOST", "SERVER_ALLOWED_ORIGINS"].filter((key) => !!env[key]);
  }
  static async create(database: Client, path: string, env: NodeJS.ProcessEnv = process.env, recovery = false): Promise<DashboardAuth> {
    const auth = new DashboardAuth(database, path, env);
    if (!recovery) {
      const row = await auth.read();
      if (row.mode !== "pending") markDashboardAccessConfigured(path);
    }
    return auth;
  }
  private async read(executor: Client | Transaction = this.database): Promise<AccessRow> {
    const result = await executor.execute("SELECT mode, password_hash, revision, network_json, upgrade FROM dashboard_access WHERE id = 1");
    const row = result.rows[0] as unknown as AccessRow | undefined;
    if (row?.mode === "pending" && dashboardAccessWasConfigured(this.path)) throw new Error("Previously configured dashboard authentication is missing; restore the access configuration from backup");
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
    const row = await this.read();
    if (row.network_json === null) {
      await this.database.execute({
        sql: "UPDATE dashboard_access SET network_json = ?, upgrade = ? WHERE id = 1 AND network_json IS NULL",
        args: [JSON.stringify({ hosts: [upgrade ? "0.0.0.0" : "127.0.0.1"], origins: [], originsEnabled: false }), Number(upgrade)],
      });
    }
    if (this.envPassword && (await this.read()).mode === "pending") {
      const hash = await this.hashPassword(this.envPassword);
      const tx = await this.database.transaction("write");
      try {
        const result = await tx.execute({
          sql: "UPDATE dashboard_access SET mode = 'enabled', password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending'",
          args: [hash],
        });
        if (Number(result.rowsAffected) === 1) markDashboardAccessConfigured(this.path);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    }
  }
  async getNetwork(): Promise<DashboardNetwork> {
    return NetworkSchema.parse(JSON.parse((await this.read()).network_json ?? '{"hosts":["127.0.0.1"],"origins":[]}'));
  }
  async isPending(): Promise<boolean> {
    return (await this.read()).mode === "pending" && !this.envPassword;
  }
  async isProtected(): Promise<boolean> {
    return !!this.envPassword || (await this.read()).mode === "enabled";
  }
  private generation(row: AccessRow) {
    return digest(`${row.revision}:${this.envPassword}`);
  }
  async session(request: Request, executor: Client | Transaction = this.database, row?: AccessRow): Promise<Session | null> {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token) return null;
    const result = await executor.execute({ sql: "SELECT csrf, generation, expires_at FROM dashboard_sessions WHERE token_hash = ?", args: [digest(token)] });
    const session = result.rows[0] as unknown as Session | undefined;
    const current = row ?? await this.read(executor);
    return session && Number(session.expires_at) > Date.now() && session.generation === this.generation(current) ? session : null;
  }
  async status(request: Request) {
    const row = await this.read();
    const session = await this.session(request, this.database, row);
    const pending = row.mode === "pending" && !this.envPassword;
    const protectedAccess = !!this.envPassword || row.mode === "enabled";
    return { pending, protected: protectedAccess, authenticated: !pending && (!protectedAccess || !!session), csrf: session?.csrf ?? null, upgrade: !!row.upgrade, overrides: this.overrides };
  }
  private async hashPassword(password: string): Promise<string> {
    if (this.activeHashings >= 2) throw new AccessError("try_later", 429);
    this.activeHashings++;
    try {
      return await Bun.password.hash(password, { algorithm: "argon2id" });
    } finally {
      this.activeHashings--;
    }
  }
  private async verify(password: string) {
    if (password.length > 1024 || this.activeVerifications >= 2) throw new AccessError("try_later", 429);
    if (Date.now() - this.attemptWindow > 60_000) {
      this.attemptWindow = Date.now();
      this.attempts = 0;
    }
    if (++this.attempts > 15) throw new AccessError("try_later", 429);
    this.activeVerifications++;
    try {
      const row = await this.read();
      const valid = this.envPassword
        ? timingSafeEqual(Buffer.from(digest(password)), Buffer.from(digest(this.envPassword)))
        : !!row.password_hash && (await Bun.password.verify(password, row.password_hash));
      const current = await this.read();
      if (!valid || this.generation(row) !== this.generation(current)) throw new AccessError("incorrect_password", 401);
      return row.revision;
    } finally {
      this.activeVerifications--;
    }
  }
  async issueSession(request: Request, expectedRevision?: number) {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    const tx = await this.database.transaction("write");
    try {
      const row = await this.read(tx);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new AccessError("configuration_changed", 409);
      await tx.execute({ sql: "DELETE FROM dashboard_sessions WHERE expires_at <= ?", args: [Date.now()] });
      await tx.execute({
        sql: "INSERT INTO dashboard_sessions (token_hash, csrf, generation, expires_at) VALUES (?, ?, ?, ?)",
        args: [digest(token), csrf, this.generation(row), Date.now() + SESSION_SECONDS * 1000],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    return { csrf, cookie: `raceiq_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}` };
  }
  async login(password: string, request: Request) {
    if ((await this.isPending()) || !(await this.isProtected())) throw new AccessError("not_available", 409);
    return this.issueSession(request, await this.verify(password));
  }
  async logout(request: Request) {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (token) await this.database.execute({ sql: "DELETE FROM dashboard_sessions WHERE token_hash = ?", args: [digest(token)] });
    return "raceiq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
  }
  async setup(password: string | null, exposureConfirmed: boolean): Promise<number> {
    if (!(await this.isPending())) throw new AccessError("already_configured", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const hash = password === null ? null : await this.hashPassword(password);
    const tx = await this.database.transaction("write");
    try {
      const changed = await tx.execute({
        sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending' RETURNING revision",
        args: [password === null ? "disabled" : "enabled", hash],
      });
      if (changed.rows.length !== 1) throw new AccessError("already_configured", 409);
      markDashboardAccessConfigured(this.path);
      await tx.commit();
      return Number(changed.rows[0]!.revision);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  async changePassword(current: string, password: string | null, exposureConfirmed: boolean): Promise<number> {
    if (this.envPassword) throw new AccessError("environment_override", 409);
    const row = await this.read();
    if (row.mode === "pending") throw new AccessError("not_available", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const revision = row.mode === "enabled" ? await this.verify(current) : row.revision;
    const hash = password === null ? null : await this.hashPassword(password);
    const tx = await this.database.transaction("write");
    try {
      const result = await tx.execute({
        sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND revision = ? AND mode != 'pending' RETURNING revision",
        args: [password === null ? "disabled" : "enabled", hash, revision],
      });
      if (result.rows.length !== 1) throw new AccessError("configuration_changed", 409);
      await tx.execute("DELETE FROM dashboard_sessions");
      await tx.commit();
      return Number(result.rows[0]!.revision);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  async saveNetwork(input: DashboardNetworkInput) {
    const existing = await this.getNetwork();
    const network = NetworkSchema.parse(input);
    const sameHosts = JSON.stringify(existing.hosts) === JSON.stringify(network.hosts),
      sameOrigins = JSON.stringify(existing.origins) === JSON.stringify(network.origins),
      sameOriginsEnabled = existing.originsEnabled === network.originsEnabled;
    if ((this.env.SERVER_HOST && !sameHosts) || (this.env.SERVER_ALLOWED_ORIGINS && (!sameOrigins || !sameOriginsEnabled))) throw new AccessError("environment_override", 409);
    const validated = validateNetwork({ ...network, hosts: sameHosts ? ["127.0.0.1"] : network.hosts });
    await this.database.execute({ sql: "UPDATE dashboard_access SET network_json = ? WHERE id = 1", args: [JSON.stringify({ ...validated, hosts: sameHosts ? existing.hosts : validated.hosts })] });
  }
  async reset(password: string) {
    if (this.envPassword) throw new AccessError("environment_override", 409);
    PasswordSchema.parse(password);
    await this.replaceProtection(await this.hashPassword(password));
  }
  async disable() {
    if (this.envPassword) throw new AccessError("environment_override", 409);
    await this.replaceProtection(null);
  }
  private async replaceProtection(hash: string | null) {
    const tx = await this.database.transaction("write");
    try {
      const result = await tx.execute({ sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND network_json IS NOT NULL", args: [hash === null ? "disabled" : "enabled", hash] });
      if (Number(result.rowsAffected) !== 1) throw new AccessError("restore_configuration", 409);
      markDashboardAccessConfigured(this.path);
      await tx.execute("DELETE FROM dashboard_sessions");
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
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
