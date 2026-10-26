import type { Client, Transaction } from "@libsql/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { z } from "zod";
import { dashboardAccessWasConfigured, markDashboardAccessConfigured } from "@raceiq/backend-core/runtime/config/dashboard-access-state";
import { withDatabaseTransaction, withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";
import type { OnlineWorkerPort } from "@raceiq/online/server/worker-protocol";

export type DashboardAuthOnlinePort = Pick<OnlineWorkerPort, "beginDashboardSignIn" | "completeDashboardSignIn" | "consumeDashboardSignIn" | "cancelDashboardSignIn">;
export type DiscordAttempt = { id: string; workerAttemptId?: string; callbackId: string; flow: string; origin: string; revision: number; expiresAt: number; complete?: boolean; userId?: string; language?: string; sessionHash?: string; csrf?: string; finishing?: boolean; abort?: AbortController; expiryTimer?: ReturnType<typeof setTimeout> };
const FLOW_SECONDS = 10 * 60;
const MAX_DISCORD_ATTEMPTS = 256;

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
type IssuedSession = { csrf: string; cookie: string };
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
  private readonly discordAttempts = new Map<string, DiscordAttempt>();
  private discordMode = false;
  private ownerId: string | null = null;
  private attempts = 0;
  private attemptWindow = 0;
  private activeHashings = 0;
  private activeVerifications = 0;
  private readonly path: string;
  private readonly database: Client;
  private readonly readDatabase: Client;
  private readonly online?: DashboardAuthOnlinePort;
  private constructor(database: Client, path: string, env: NodeJS.ProcessEnv, readDatabase: Client, online?: DashboardAuthOnlinePort) {
    this.path = path;
    this.database = database;
    this.readDatabase = readDatabase;
    this.online = online;
    this.env = env;
    this.envPassword = env.SERVER_PASSWORD || "";
    if (this.envPassword && !PasswordSchema.safeParse(this.envPassword).success) throw new Error("SERVER_PASSWORD must contain at least 8 characters (maximum 1024)");
    this.overrides = ["SERVER_PASSWORD", "SERVER_HOST", "SERVER_ALLOWED_ORIGINS"].filter((key) => !!env[key]);
  }
  static async create(database: Client, path: string, env: NodeJS.ProcessEnv = process.env, recovery = false, readDatabase: Client = database, online?: DashboardAuthOnlinePort): Promise<DashboardAuth> {
    const auth = new DashboardAuth(database, path, env, readDatabase, online);
    if (!recovery) {
      const row = await auth.read();
      await auth.refreshDiscordOwner();
      if (row.mode !== "pending" || auth.discordMode) markDashboardAccessConfigured(path);
    }
    return auth;
  }
  private async read(executor: Client | Transaction = this.readDatabase): Promise<AccessRow> {
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
  private async refreshDiscordOwner(executor: Client | Transaction = this.readDatabase) {
    const ownerResult = await executor.execute("SELECT online_user_id FROM local_account_owner WHERE id = 1");
    this.ownerId = (ownerResult.rows[0] as { online_user_id?: string | null } | undefined)?.online_user_id ?? null;
    try {
      const result = await executor.execute("SELECT method FROM dashboard_auth_method WHERE id = 1");
      const method = (result.rows[0] as { method?: string } | undefined)?.method;
      this.discordMode = method === "discord" || (!method && !!this.ownerId);
      if (method === "password" || method === "none") this.discordMode = false;
    } catch {
      this.discordMode = !!this.ownerId;
    }
  }
  async initialize(upgrade: boolean) {
    const row = await this.read();
    if (row.network_json === null) {
      await withDatabaseWrite(() => this.database.execute({
        sql: "UPDATE dashboard_access SET network_json = ?, upgrade = ? WHERE id = 1 AND network_json IS NULL",
        args: [JSON.stringify({ hosts: [upgrade ? "0.0.0.0" : "127.0.0.1"], origins: [], originsEnabled: false }), Number(upgrade)],
      }));
    }
    if (this.envPassword && (await this.read()).mode === "pending") {
      const hash = await this.hashPassword(this.envPassword);
      const changed = await withDatabaseTransaction(this.database, async (tx) => {
        const result = await tx.execute({
          sql: "UPDATE dashboard_access SET mode = 'enabled', password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending'",
          args: [hash],
        });
        return Number(result.rowsAffected) === 1;
      });
      if (changed) markDashboardAccessConfigured(this.path);
    }
  }
  async getNetwork(): Promise<DashboardNetwork> {
    return NetworkSchema.parse(JSON.parse((await this.read()).network_json ?? '{"hosts":["127.0.0.1"],"origins":[]}'));
  }
  async isPending(): Promise<boolean> {
    await this.refreshDiscordOwner();
    return (await this.read()).mode === "pending" && !this.envPassword && !this.discordMode;
  }
  async isProtected(): Promise<boolean> {
    await this.refreshDiscordOwner();
    return !!this.envPassword || this.discordMode || (await this.read()).mode === "enabled";
  }
  private generation(row: AccessRow) {
    return digest(`${row.revision}:${this.envPassword}:${this.discordMode ? "discord" : ""}`);
  }
  async session(request: Request, executor: Client | Transaction = this.readDatabase, row?: AccessRow): Promise<Session | null> {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token) return null;
    const result = await executor.execute({ sql: "SELECT csrf, generation, expires_at FROM dashboard_sessions WHERE token_hash = ?", args: [digest(token)] });
    const session = result.rows[0] as unknown as Session | undefined;
    const current = row ?? await this.read(executor);
    return session && Number(session.expires_at) > Date.now() && session.generation === this.generation(current) ? session : null;
  }
  async status(request: Request) {
    const row = await this.read();
    await this.refreshDiscordOwner();
    const session = await this.session(request, this.readDatabase, row);
    const method = this.envPassword ? "password" : this.discordMode ? "discord" : row.mode === "enabled" ? "password" : row.mode === "disabled" ? "none" : null;
    const pending = row.mode === "pending" && !this.envPassword && !this.discordMode;
    const protectedAccess = !!this.envPassword || this.discordMode || row.mode === "enabled";
    return { pending, method, protected: protectedAccess, authenticated: !pending && (!protectedAccess || !!session), csrf: session?.csrf ?? null, upgrade: !!row.upgrade, overrides: this.overrides };
  }
  async beginDiscordSignIn(input: { callbackUrl: string; flow: string; origin: string; request: Request; language?: string }) {
    const row = await this.read();
    await this.refreshDiscordOwner();
    if (this.envPassword) throw new AccessError("environment_override", 409);
    let sessionHash: string | undefined;
    let csrf: string | undefined;
    if (row.mode === "enabled" && !this.discordMode) {
      const session = await this.session(input.request);
      const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(input.request.headers.get("cookie") ?? "")?.[1];
      csrf = input.request.headers.get("x-raceiq-csrf") ?? undefined;
      if (!session || !token) throw new AccessError("authentication_required", 401);
      if (!csrf || csrf !== session.csrf) throw new AccessError("csrf_mismatch", 403);
      sessionHash = digest(token);
    }
    if (!this.online) throw new AccessError("provider_unavailable", 503);
    const now = Date.now();
    for (const [id, item] of this.discordAttempts) if (item.expiresAt <= now) this.discordAttempts.delete(id);
    if (this.discordAttempts.size >= MAX_DISCORD_ATTEMPTS) throw new AccessError("try_later", 429);
    const attemptId = randomBytes(32).toString("hex"), callbackId = randomBytes(32).toString("hex");
    const attempt: DiscordAttempt = { id: attemptId, callbackId, flow: input.flow, origin: input.origin, revision: row.revision, expiresAt: now + FLOW_SECONDS * 1000, language: input.language, sessionHash, csrf };
    this.discordAttempts.set(attemptId, attempt);
    try {
      const result = await this.online.beginDashboardSignIn({ callbackUrl: `${input.callbackUrl}?flow=${callbackId}` });
      attempt.workerAttemptId = result.attemptId;
      return { attemptId, authorizationUrl: result.authorizationUrl, expiresAt: Math.min(result.expiresAt, attempt.expiresAt) };
    } catch {
      this.discordAttempts.delete(attemptId);
      throw new AccessError("provider_unavailable", 503);
    }
  }
  async completeDiscordSignIn(callbackId: string, callbackUrl: string) {
    const attempt = [...this.discordAttempts.values()].find((entry) => entry.callbackId === callbackId);
    if (!attempt || !attempt.workerAttemptId || attempt.complete || attempt.expiresAt <= Date.now()) throw new AccessError("invalid_completion");
    if (!this.online) throw new AccessError("provider_unavailable", 503);
    try {
      const callback = new URL(callbackUrl);
      if (callback.pathname !== "/api/auth/discord/callback" || callback.origin !== attempt.origin) throw new AccessError("invalid_completion");
      const verifiedCallbackUrl = callback.toString();
      const result = await this.online.completeDashboardSignIn({ attemptId: attempt.workerAttemptId, callbackUrl: verifiedCallbackUrl });
      await this.refreshDiscordOwner();
      if (this.ownerId && this.ownerId !== result.userId) {
        await this.cancelDiscordSignIn(attempt.flow);
        throw new AccessError("wrong_account", 403);
      }
      attempt.complete = true;
      attempt.userId = result.userId;
      return attempt;
    } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError("invalid_completion");
    }
  }
  async finishDiscordSignIn(flow: string, request: Request) {
    const attempt = [...this.discordAttempts.values()].find((entry) => entry.flow === flow);
    if (!attempt || attempt.expiresAt <= Date.now()) throw new AccessError("invalid_flow", 401);
    if (attempt.finishing) throw new AccessError("flow_in_progress", 409);
    if (!attempt.complete || !attempt.userId || !attempt.workerAttemptId) return { pending: true as const };
    const userId = attempt.userId;
    const workerAttemptId = attempt.workerAttemptId;
    attempt.finishing = true;
    attempt.abort = new AbortController();
    attempt.expiryTimer = setTimeout(() => attempt.abort?.abort(new AccessError("invalid_flow", 401)), Math.max(0, attempt.expiresAt - Date.now()));
    attempt.expiryTimer.unref?.();
    const current = () => this.discordAttempts.get(attempt.id) === attempt && attempt.expiresAt > Date.now();
    let protectedRevision: number;
    try {
      protectedRevision = await withDatabaseTransaction(this.database, async (tx) => {
        if (!current()) throw new AccessError("invalid_flow", 401);
        const row = await this.read(tx);
        if (row.revision !== attempt.revision) throw new AccessError("configuration_changed", 409);
        if (attempt.sessionHash) {
          const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
          const session = await this.session(request, tx, row);
          if (!token || digest(token) !== attempt.sessionHash || !session) throw new AccessError("authentication_required", 401);
          if (session.csrf !== attempt.csrf || request.headers.get("x-raceiq-csrf") !== attempt.csrf) throw new AccessError("csrf_mismatch", 403);
        }
        await tx.execute("INSERT INTO local_account_owner (id, online_user_id) VALUES (1, NULL) ON CONFLICT(id) DO NOTHING");
        const ownerResult = await tx.execute("SELECT online_user_id FROM local_account_owner WHERE id = 1");
        const owner = (ownerResult.rows[0] as { online_user_id?: string | null } | undefined)?.online_user_id;
        if (owner === undefined) throw new AccessError("configuration_changed", 409);
        if (owner !== null && owner !== userId) throw new AccessError("wrong_account", 403);
        if (owner === null) {
          const claim = await tx.execute({ sql: "UPDATE local_account_owner SET online_user_id = ? WHERE id = 1 AND online_user_id IS NULL", args: [userId] });
          if (Number(claim.rowsAffected) !== 1) throw new AccessError("configuration_changed", 409);
          await tx.execute({ sql: "UPDATE sessions SET owner_user_id = ? WHERE owner_user_id IS NULL AND ownership = 'mine' AND cloud_import_origin IS NULL AND cloud_import_lap_id IS NULL", args: [userId] });
        }
        const transition = row.mode !== "disabled" || !this.discordMode;
        let revision = row.revision;
        if (transition) {
          const updated = await tx.execute({ sql: "UPDATE dashboard_access SET mode = 'disabled', password_hash = NULL, revision = revision + 1 WHERE id = 1 AND revision = ? RETURNING revision", args: [row.revision] });
          if (updated.rows.length !== 1) throw new AccessError("configuration_changed", 409);
          revision = Number(updated.rows[0]!.revision);
        }
        await tx.execute("INSERT INTO dashboard_auth_method (id,method) VALUES (1,'discord') ON CONFLICT(id) DO UPDATE SET method='discord'");
        if (!current()) throw new AccessError("invalid_flow", 401);
        return revision;
      }, { signal: attempt.abort.signal });
    } catch (error) {
      if (error instanceof AccessError) await this.cancelDiscordSignIn(flow);
      else if (this.discordAttempts.get(attempt.id) === attempt) attempt.finishing = false;
      throw error;
    }
    markDashboardAccessConfigured(this.path);
    this.discordMode = true;
    this.ownerId = userId;
    if (!current()) {
      await this.cancelDiscordSignIn(flow);
      throw new AccessError("invalid_flow", 401);
    }
    if (!this.online) throw new AccessError("provider_unavailable", 503);
    let adopted: { userId: string };
    try { adopted = await this.online.consumeDashboardSignIn({ attemptId: workerAttemptId }); }
    catch {
      await this.cancelDiscordSignIn(flow);
      throw new AccessError("provider_unavailable", 503);
    }
    if (adopted.userId !== userId) {
      await this.cancelDiscordSignIn(flow);
      throw new AccessError("wrong_account", 403);
    }
    if (!current()) {
      await this.cancelDiscordSignIn(flow);
      throw new AccessError("invalid_flow", 401);
    }
    let session: IssuedSession;
    try { session = await this.issueSession(request, protectedRevision, current); }
    catch (error) {
      await this.cancelDiscordSignIn(flow);
      throw error;
    }
    if (!current()) {
      await this.logout(new Request(request.url, { headers: { cookie: session.cookie.split(";")[0]! } }));
      await this.cancelDiscordSignIn(flow);
      throw new AccessError("invalid_flow", 401);
    }
    clearTimeout(attempt.expiryTimer);
    this.discordAttempts.delete(attempt.id);
    return { pending: false as const, ...session, language: attempt.language };
  }
  async cancelDiscordSignIn(flow: string) {
    const attempt = [...this.discordAttempts.values()].find((entry) => entry.flow === flow);
    if (!attempt) return;
    attempt.abort?.abort(new AccessError("invalid_flow", 401));
    clearTimeout(attempt.expiryTimer);
    this.discordAttempts.delete(attempt.id);
    if (!attempt.workerAttemptId || !this.online) return;
    try { await this.online.cancelDashboardSignIn({ attemptId: attempt.workerAttemptId }); } catch {}
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
  async issueSession(request: Request, expectedRevision?: number, isCurrent?: () => boolean): Promise<IssuedSession> {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    await withDatabaseTransaction(this.database, async (tx) => {
      const row = await this.read(tx);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new AccessError("configuration_changed", 409);
      if (isCurrent && !isCurrent()) throw new AccessError("invalid_flow", 401);
      await tx.execute({ sql: "DELETE FROM dashboard_sessions WHERE expires_at <= ?", args: [Date.now()] });
      await tx.execute({
        sql: "INSERT INTO dashboard_sessions (token_hash, csrf, generation, expires_at) VALUES (?, ?, ?, ?)",
        args: [digest(token), csrf, this.generation(row), Date.now() + SESSION_SECONDS * 1000],
      });
    });
    const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    return { csrf, cookie: `raceiq_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}` };
  }
  async login(password: string, request: Request) {
    if ((await this.isPending()) || !(await this.isProtected())) throw new AccessError("not_available", 409);
    if (this.discordMode && !this.envPassword) throw new AccessError("discord_login_required", 409);
    return this.issueSession(request, await this.verify(password));
  }
  async logout(request: Request) {
    const token = /(?:^|;\s*)raceiq_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (token) await withDatabaseWrite(() => this.database.execute({ sql: "DELETE FROM dashboard_sessions WHERE token_hash = ?", args: [digest(token)] }));
    return "raceiq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
  }
  async setup(password: string | null, exposureConfirmed: boolean): Promise<number> {
    if (!(await this.isPending())) throw new AccessError("already_configured", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const hash = password === null ? null : await this.hashPassword(password);
    const revision = await withDatabaseTransaction(this.database, async (tx) => {
      const changed = await tx.execute({
        sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND mode = 'pending' RETURNING revision",
        args: [password === null ? "disabled" : "enabled", hash],
      });
      if (changed.rows.length !== 1) throw new AccessError("already_configured", 409);
      return Number(changed.rows[0]!.revision);
    });
    markDashboardAccessConfigured(this.path);
    return revision;
  }
  async changePassword(current: string, password: string | null, exposureConfirmed: boolean): Promise<number> {
    await this.refreshDiscordOwner();
    if (this.envPassword || this.discordMode) throw new AccessError("environment_override", 409);
    const row = await this.read();
    if (row.mode === "pending") throw new AccessError("not_available", 409);
    if (password !== null && !PasswordSchema.safeParse(password).success) throw new AccessError("password_length");
    if (password === null && !exposureConfirmed) throw new AccessError("confirm_exposure");
    const revision = row.mode === "enabled" ? await this.verify(current) : row.revision;
    const hash = password === null ? null : await this.hashPassword(password);
    return withDatabaseTransaction(this.database, async (tx) => {
      const result = await tx.execute({
        sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND revision = ? AND mode != 'pending' RETURNING revision",
        args: [password === null ? "disabled" : "enabled", hash, revision],
      });
      if (result.rows.length !== 1) throw new AccessError("configuration_changed", 409);
      await tx.execute("DELETE FROM dashboard_sessions");
      return Number(result.rows[0]!.revision);
    });
  }
  async saveNetwork(input: DashboardNetworkInput) {
    const existing = await this.getNetwork();
    const network = NetworkSchema.parse(input);
    const sameHosts = JSON.stringify(existing.hosts) === JSON.stringify(network.hosts),
      sameOrigins = JSON.stringify(existing.origins) === JSON.stringify(network.origins),
      sameOriginsEnabled = existing.originsEnabled === network.originsEnabled;
    if ((this.env.SERVER_HOST && !sameHosts) || (this.env.SERVER_ALLOWED_ORIGINS && (!sameOrigins || !sameOriginsEnabled))) throw new AccessError("environment_override", 409);
    const validated = validateNetwork({ ...network, hosts: sameHosts ? ["127.0.0.1"] : network.hosts });
    await withDatabaseWrite(() => this.database.execute({ sql: "UPDATE dashboard_access SET network_json = ? WHERE id = 1", args: [JSON.stringify({ ...validated, hosts: sameHosts ? existing.hosts : validated.hosts })] }));
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
    await withDatabaseTransaction(this.database, async (tx) => {
      const result = await tx.execute({ sql: "UPDATE dashboard_access SET mode = ?, password_hash = ?, revision = revision + 1 WHERE id = 1 AND network_json IS NOT NULL", args: [hash === null ? "disabled" : "enabled", hash] });
      if (Number(result.rowsAffected) !== 1) throw new AccessError("restore_configuration", 409);
      await tx.execute("DELETE FROM dashboard_sessions");
      await tx.execute({ sql: "INSERT INTO dashboard_auth_method(id,method) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET method=excluded.method", args: [hash === null ? "none" : "password"] });
    });
    markDashboardAccessConfigured(this.path);
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
