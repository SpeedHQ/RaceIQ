import { createHash } from "node:crypto";

const port = Number(process.env.IRACING_FIXTURE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("IRACING_FIXTURE_PORT must be a valid TCP port");
const challenges = new Map<string, string>();
const clientSecrets: Record<string, string> = {
  "raceiq-e2e-client": "fixture-client-secret",
  "raceiq-e2e-client-replaced": "fixture-client-secret-replaced",
};
let recentRacesStatus = 200;
let recentRacesEmpty = false;
let refreshStatus = 200;
let lastAuthorizationState: string | null = null;
let customerId = 424242;
let scenarioId = 0;
const recentRaces = {
  races: [
    { subsession_id: 9003, category_id: 2, oldi_rating: 1510, newi_rating: 1542, session_start_time: "2026-10-20T18:00:00Z" },
    { subsession_id: 9004, category_id: 2, oldi_rating: 1542, newi_rating: 1550, session_start_time: "2026-10-18T16:30:00Z" },
    { subsession_id: 9002, category_id: 1, oldi_rating: 1720, newi_rating: 1688, session_start_time: "2026-10-18T16:30:00Z" },
    { subsession_id: 9001, category_id: 2, oldi_rating: 1480, newi_rating: 1510, session_start_time: "2026-10-16T19:15:00Z" },
  ],
};
const json = (value: unknown, status = 200) => Response.json(value, { status });

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/fixtures/control" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { status?: unknown; customerId?: unknown; empty?: unknown; refreshStatus?: unknown; isolate?: unknown } | null;
      if (!body || (body.status !== undefined && body.status !== 200 && body.status !== 429 && body.status !== 503) ||
          (body.customerId !== undefined && (typeof body.customerId !== "number" || !Number.isSafeInteger(body.customerId) || body.customerId < 1)) ||
          (body.empty !== undefined && typeof body.empty !== "boolean") ||
          (body.refreshStatus !== undefined && body.refreshStatus !== 200 && body.refreshStatus !== 503) ||
          (body.isolate !== undefined && typeof body.isolate !== "boolean")) return json({ error: "invalid_control" }, 400);
      if (body.status !== undefined) recentRacesStatus = body.status;
      if (body.customerId !== undefined) customerId = body.customerId;
      if (body.empty !== undefined) recentRacesEmpty = body.empty;
      if (body.refreshStatus !== undefined) refreshStatus = body.refreshStatus;
      if (body.isolate) scenarioId++;
      return json({ status: recentRacesStatus, customerId, empty: recentRacesEmpty, refreshStatus });
    }
    if (url.pathname === "/fixtures/last-state" && request.method === "GET") return json({ state: lastAuthorizationState });

    if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!state || !challenge || method !== "S256" || !redirectUri) return json({ error: "invalid_request" }, 400);
      challenges.set(state, challenge);
      lastAuthorizationState = state;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "fixture-authorization-code");
      callback.searchParams.set("state", state);
      return Response.redirect(callback, 302);
    }

    if (url.pathname === "/oauth2/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const clientId = form.get("client_id") ?? "";
      const secret = Object.hasOwn(clientSecrets, clientId) ? clientSecrets[clientId] : undefined;
      const expectedSecret = secret === undefined ? null : createHash("sha256").update(`${secret}${clientId.trim().toLowerCase()}`, "utf8").digest("base64");
      if (!expectedSecret || form.get("client_secret") !== expectedSecret) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        const state = [...challenges.keys()].find((candidate) => challenges.get(candidate) === createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"));
        if (form.get("code") !== "fixture-authorization-code" || !state || !form.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
        challenges.delete(state);
        return json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 0, refresh_token: "fixture-refresh-token", refresh_token_expires_in: 86400, scope: "iracing.auth" });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (refreshStatus !== 200) return json({ error: "temporarily_unavailable" }, refreshStatus);
        if (form.get("refresh_token") === "fixture-refresh-token" || form.get("refresh_token") === "fixture-refresh-token-rotated") {
          return json({ access_token: "fixture-refreshed-access-token", token_type: "Bearer", expires_in: 0, refresh_token: "fixture-refresh-token-rotated", refresh_token_expires_in: 86400, scope: "iracing.auth" });
        }
      }
      return json({ error: "invalid_grant" }, 400);
    }

    if (url.pathname === "/oauth2/iracing/profile" && request.method === "GET") {
      if (!request.headers.get("authorization")?.startsWith("Bearer fixture-")) return json({ error: "unauthorized" }, 401);
      return json({ iracing_cust_id: customerId, iracing_name: "RaceIQ Fixture Driver" });
    }

    if (url.pathname === "/data/stats/member_recent_races" && request.method === "GET") {
      if (!request.headers.get("authorization")?.startsWith("Bearer fixture-")) return json({ error: "unauthorized" }, 401);
      if (!url.searchParams.has("cust_id")) return json({ error: "missing_customer_id" }, 400);
      return json({ link: `${url.origin}/fixtures/recent-races` });
    }

    if (url.pathname === "/fixtures/recent-races" && request.method === "GET") {
      const races = recentRaces.races.map((race) => ({ ...race, subsession_id: scenarioId * 100_000 + race.subsession_id }));
      return json(recentRacesEmpty ? [] : { races }, recentRacesStatus);
    }
    return json({ error: "not_found" }, 404);
  },
});
console.info(`iRacing upstream fixture listening on ${port}`);
