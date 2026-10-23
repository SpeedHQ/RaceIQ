import { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { iracingRatingEvents, iracingRatingSyncState } from "@raceiq/backend-core/db/schema";
import { withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";
import { getSecret, setSecret } from "@raceiq/backend-core/runtime/platform/keystore";
import { IS_E2E } from "@raceiq/backend-core/runtime/config/env";

const E2E_IRACING_UPSTREAM = IS_E2E && process.env.RACEIQ_E2E_IRACING_UPSTREAM
  ? new URL(process.env.RACEIQ_E2E_IRACING_UPSTREAM).origin
  : null;
const OAUTH = E2E_IRACING_UPSTREAM ? `${E2E_IRACING_UPSTREAM}/oauth2` : "https://oauth.iracing.com/oauth2";
const CLIENT_ID_KEY = "irating.client-id";
const CLIENT_SECRET_KEY = "irating.client-secret";
const TOKEN_KEY = "irating.token";
const states = new Map<string, { verifier: string; expiresAt: number }>();
const callbackPath = "/api/iracing-rating/callback";

const upstreamBase = E2E_IRACING_UPSTREAM ?? "https://members-ng.iracing.com";
const allowedDataLinkOrigins = new Set(E2E_IRACING_UPSTREAM
  ? [E2E_IRACING_UPSTREAM]
  : ["https://members-ng.iracing.com", "https://ir-dl.s3.amazonaws.com"]);
const categories = new Map([[1, "Oval"], [2, "Road"], [3, "Dirt Oval"], [4, "Dirt Road"]]);
let tokenGeneration = 0;
function maskClientSecret(secret: string, clientId: string): string {
  return createHash("sha256").update(`${secret}${clientId.trim().toLowerCase()}`, "utf8").digest("base64");
}


async function clearStoredToken(): Promise<void> {
  tokenGeneration++;
  states.clear();
  const pendingRefresh = refreshFlight;
  if (pendingRefresh) await pendingRefresh;
  await setSecret(TOKEN_KEY, "");
}
let refreshFlight: Promise<Record<string, unknown> | null> | null = null;

async function currentToken(): Promise<Record<string, unknown> | null> {
  const raw = await getSecret(TOKEN_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw) as Record<string, unknown>;
  if (typeof saved.access_token !== "string" || typeof saved.customerId !== "number") return null;
  if (typeof saved.expiresAt === "number" && saved.expiresAt > Date.now() + 60_000) return saved;
  if (typeof saved.refresh_token !== "string") return null;
  if (!refreshFlight) {
    const generation = tokenGeneration;
    refreshFlight = (async () => {
      try {
        const clientId = await getSecret(CLIENT_ID_KEY);
        const clientSecret = await getSecret(CLIENT_SECRET_KEY);
        const response = await fetch(`${OAUTH}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: maskClientSecret(clientSecret, clientId), refresh_token: saved.refresh_token as string }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const refreshed = await response.json() as Record<string, unknown>;
        if (typeof refreshed.access_token !== "string" || typeof refreshed.expires_in !== "number" || generation !== tokenGeneration) return null;
        const next = { ...saved, ...refreshed, refresh_token: typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : saved.refresh_token, expiresAt: Date.now() + refreshed.expires_in * 1000 };
        await setSecret(TOKEN_KEY, JSON.stringify(next));
        return next;
      } catch {
        return null;
      }
    })().finally(() => { refreshFlight = null; });
  }
  return refreshFlight;
}

async function fetchJson(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("upstream_failure");
  return response.json();
}

export function parseRecentRaceRows(value: unknown): Array<{ eventId: string; categoryId: number; observedAt: string; irating: number; change: number }> {
  if (!Array.isArray(value)) throw new Error("invalid_payload");
  const rows = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.subsession_id !== "number" || !Number.isSafeInteger(row.subsession_id) ||
        typeof row.category_id !== "number" || !categories.has(row.category_id) ||
        typeof row.session_start_time !== "string" || !Number.isFinite(Date.parse(row.session_start_time)) ||
        typeof row.newi_rating !== "number" || !Number.isSafeInteger(row.newi_rating) ||
        typeof row.oldi_rating !== "number" || !Number.isSafeInteger(row.oldi_rating)) continue;
    rows.push({ eventId: `${row.subsession_id}:${row.category_id}`, categoryId: row.category_id, observedAt: new Date(row.session_start_time).toISOString(), irating: row.newi_rating, change: row.newi_rating - row.oldi_rating });
  }
  return rows;
}

function originUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  return `${request.origin}${callbackPath}`;
}

export const iracingRatingRoutes = new Hono()
  .use("/api/iracing-rating/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  })
  .get("/api/iracing-rating/status", async (c) => {
    const clientId = await getSecret(CLIENT_ID_KEY);
    const token = await currentToken();
    let customerId: number | null = typeof token?.customerId === "number" ? token.customerId : null;
    let displayName: string | null = typeof token?.displayName === "string" ? token.displayName : null;
    if (token && customerId === null) {
      try {
        const response = await fetch(`${OAUTH}/iracing/profile`, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const profile = await response.json() as { iracing_cust_id?: number; iracing_name?: string };
          customerId = typeof profile.iracing_cust_id === "number" ? profile.iracing_cust_id : null;
          displayName = typeof profile.iracing_name === "string" ? profile.iracing_name : null;
        }
      } catch { /* Status remains safe and disconnected on provider failure. */ }
    }
    const [sync] = customerId === null ? [] : await db.select().from(iracingRatingSyncState).where(eq(iracingRatingSyncState.customerId, customerId)).limit(1);
    return c.json({ configured: Boolean(clientId), connected: Boolean(token && customerId), customerId, displayName, lastSyncedAt: sync?.lastSyncedAt ?? null });
  })
  .put("/api/iracing-rating/client", async (c) => {
    const body = await c.req.json().catch(() => null) as { clientId?: unknown; clientSecret?: unknown; redirectUri?: unknown } | null;
    if (!body || typeof body.clientId !== "string" || !body.clientId.trim() || typeof body.clientSecret !== "string" || !body.clientSecret.trim() || body.redirectUri !== originUrl(c.req.url)) return c.json({ error: "invalid_client_configuration" }, 400);
    await clearStoredToken();
    await setSecret(CLIENT_ID_KEY, body.clientId.trim());
    await setSecret(CLIENT_SECRET_KEY, body.clientSecret);
    const [storedClientId, storedClientSecret] = await Promise.all([getSecret(CLIENT_ID_KEY), getSecret(CLIENT_SECRET_KEY)]);
    if (storedClientId !== body.clientId.trim() || storedClientSecret !== body.clientSecret) return c.json({ error: "keystore_unavailable" }, 503);
    return c.json({ configured: true });
  })
  .delete("/api/iracing-rating/client", async (c) => {
    await clearStoredToken();
    await setSecret(CLIENT_ID_KEY, "");
    await setSecret(CLIENT_SECRET_KEY, "");
    return c.json({ configured: false });
  })
  .get("/api/iracing-rating/authorize", async (c) => {
    const clientId = await getSecret(CLIENT_ID_KEY);
    if (!clientId) return c.json({ error: "not_configured" }, 409);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    for (const [key, value] of states) if (value.expiresAt <= Date.now()) states.delete(key);
    while (states.size >= 256) states.delete(states.keys().next().value!);
    states.set(state, { verifier, expiresAt: Date.now() + 10 * 60_000 });
    const authorize = new URL(`${OAUTH}/authorize`);
    authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: originUrl(c.req.url), response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, scope: "iracing.auth" }).toString();
    return c.redirect(authorize.toString(), 302);
  })
  .get("/api/iracing-rating/callback", async (c) => {
    const state = c.req.query("state"); const code = c.req.query("code");
    const pending = state ? states.get(state) : undefined;
    if (state) states.delete(state);
    if (!pending || pending.expiresAt <= Date.now() || !code) return c.redirect("/iracing/rating?rating=error", 302);
    const clientId = await getSecret(CLIENT_ID_KEY); const clientSecret = await getSecret(CLIENT_SECRET_KEY);
    if (!clientId || !clientSecret) return c.redirect("/iracing/rating?rating=error", 302);
    const generation = tokenGeneration;
    try {
      const response = await fetch(`${OAUTH}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: maskClientSecret(clientSecret, clientId), code, redirect_uri: originUrl(c.req.url), code_verifier: pending.verifier }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return c.redirect("/iracing/rating?rating=error", 302);
      const token = await response.json() as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; refresh_token?: unknown; refresh_token_expires_in?: unknown; scope?: unknown };
      if (typeof token.access_token !== "string" || token.token_type !== "Bearer" || typeof token.expires_in !== "number") return c.redirect("/iracing/rating?rating=error", 302);
      const profileResponse = await fetch(`${OAUTH}/iracing/profile`, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (!profileResponse.ok) return c.redirect("/iracing/rating?rating=error", 302);
      const profile = await profileResponse.json() as { iracing_cust_id?: unknown; iracing_name?: unknown };
      if (typeof profile.iracing_cust_id !== "number" || typeof profile.iracing_name !== "string") return c.redirect("/iracing/rating?rating=error", 302);
      if (generation !== tokenGeneration) return c.redirect("/iracing/rating?rating=error", 302);
      await setSecret(TOKEN_KEY, JSON.stringify({ ...token, customerId: profile.iracing_cust_id, displayName: profile.iracing_name, expiresAt: Date.now() + token.expires_in * 1000 }));
      return c.redirect("/iracing/rating?rating=connected", 302);
    } catch { return c.redirect("/iracing/rating?rating=error", 302); }
  })
  .get("/api/iracing-rating/history", async (c) => {
    const token = await currentToken();
    if (!token) return c.json({ error: "not_connected" }, 409);
    const rows = await db.select().from(iracingRatingEvents).where(eq(iracingRatingEvents.customerId, token.customerId as number)).orderBy(asc(iracingRatingEvents.observedAt), asc(iracingRatingEvents.categoryId), asc(iracingRatingEvents.eventId));
    const entries = [];
    for (const row of rows) entries.push({ categoryId: row.categoryId, categoryName: row.categoryName, observedAt: row.observedAt, irating: row.iRating, change: row.ratingChange });
    const [sync] = await db.select().from(iracingRatingSyncState).where(eq(iracingRatingSyncState.customerId, token.customerId as number)).limit(1);
    return c.json({ customerId: token.customerId, entries, lastSyncedAt: sync?.lastSyncedAt ?? null });
  })
  .post("/api/iracing-rating/sync", async (c) => {
    const token = await currentToken();
    if (!token) return c.json({ error: "reauthorization_required" }, 409);
    try {
      const endpoint = new URL("/data/stats/member_recent_races", upstreamBase);
      const envelope = await fetchJson(`${endpoint}?cust_id=${token.customerId}`, token.access_token as string);
      let records: unknown = envelope;
      if (envelope && typeof envelope === "object" && "link" in envelope && typeof envelope.link === "string") {
        const linkedUrl = new URL(envelope.link, upstreamBase);
        const allowedProtocol = E2E_IRACING_UPSTREAM ? linkedUrl.protocol === new URL(upstreamBase).protocol : linkedUrl.protocol === "https:";
        if (!allowedDataLinkOrigins.has(linkedUrl.origin) || !allowedProtocol || linkedUrl.username || linkedUrl.password) throw new Error("untrusted_data_link");
        records = await fetchJson(linkedUrl.toString());
      }
      if (records && typeof records === "object" && "races" in records) records = records.races;
      if (!Array.isArray(records)) throw new Error("invalid_payload");
      const candidates = parseRecentRaceRows(records);
      const observedAt = new Date().toISOString();
      const values = candidates.map((row) => ({
        eventId: `${token.customerId}:${row.eventId}`,
        customerId: token.customerId as number,
        categoryId: row.categoryId,
        categoryName: categories.get(row.categoryId)!,
        observedAt: row.observedAt,
        iRating: row.irating,
        ratingChange: row.change,
      }));
      let imported = 0;
      await withDatabaseWrite(async () => {
        if (values.length) {
          const result = await db.insert(iracingRatingEvents).values(values).onConflictDoNothing().run();
          imported = result.rowsAffected;
        }
        await db.insert(iracingRatingSyncState).values({ customerId: token.customerId as number, lastSyncedAt: observedAt })
          .onConflictDoUpdate({ target: iracingRatingSyncState.customerId, set: { lastSyncedAt: observedAt } }).run();
      });
      return c.json({ imported, lastSyncedAt: observedAt });
    } catch {
      return c.json({ error: "upstream_unavailable" }, 503);
    }
  })
  .delete("/api/iracing-rating/connection", async (c) => {
    await clearStoredToken();
    return c.json({ connected: false });
  });
