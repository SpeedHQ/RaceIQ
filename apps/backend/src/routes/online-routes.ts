import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { IS_DEV } from "@raceiq/backend-core/runtime/config/env";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { RaceIqOnlinePort, OnlineErrorCode, OnlineCommandResult } from "@raceiq/shared/integrations/raceiq-online";
import { getOnlineService } from "@raceiq/backend-core/integrations/raceiq-online/service";

const id = z.string().min(1).max(512);
const context = z.object({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), accountEpoch: id }).strict();
const versions = z.object({ termsVersion: id, privacyVersion: id }).strict();
const preferences = z.object({ visibility: z.enum(["private", "public"]), setupUploads: z.boolean() }).strict();
const connect = context.extend({ acceptedPolicyVersions: versions, preferences });
const consent = context.extend({ acceptedPolicyVersions: versions });
const preferenceInput = context.extend({ preferences });
const cancel = context.extend({ flowId: id });
const board = z.object({ trackId: id, carId: id }).strict();

type CommandStatus = 200 | 202 | 400 | 401 | 403 | 409 | 429 | 500 | 503;
export function onlineErrorStatus(code: OnlineErrorCode): CommandStatus {
  switch (code) {
    case "invalid_request": case "unsupported_game": case "unknown_track": case "unknown_car": case "ineligible_lap": return 400;
    case "not_connected": case "auth_failed": case "auth_cancelled": return 401;
    case "consent_required": case "account_unavailable": return 403;
    case "stale_state": case "policy_changed": return 409;
    case "rate_limited": return 429;
    case "offline": case "service_unavailable": case "policy_unavailable": case "preferences_failed": return 503;
    default: return 500;
  }
}

const trustedHosts: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "raceiq.localhost": true };
function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Object.hasOwn(trustedHosts, url.hostname) && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

/** The factory also allows isolated runtime verification without replacing production handlers. */
type OnlineRoutePort = RaceIqOnlinePort & { handleAuthCallback(url: string): Promise<boolean> };
export function createOnlineRoutes(port: OnlineRoutePort) {
  const validate = <T extends z.ZodType>(schema: T) => zValidator("json", schema, async (result, c) => {
    if (!result.success) return c.json({ ok: false, error: { code: "invalid_request", retryable: false, retryAfter: null }, state: await port.getState() } satisfies OnlineCommandResult, 400);
  });
  return new Hono()
    .use("/api/online/*", async (c, next) => {
      const requestUrl = new URL(c.req.url);
      const origin = c.req.header("Origin");
      const fetchSite = c.req.header("Sec-Fetch-Site");
      // Same-origin desktop traffic and explicitly known local dev origins only.
      // Never reflect arbitrary origins inherited from the app's development CORS.
      let parsedOrigin: URL | null = null;
      if (origin) {
        try { parsedOrigin = new URL(origin); } catch { throw new HTTPException(400); }
      }
      const devOrigin = parsedOrigin && IS_DEV ? parsedOrigin : null;
      const devName = process.env.RACEIQ_DEV_PORTLESS_NAME ?? "raceiq";
      const allowedDevOrigin = devOrigin?.protocol === "http:" && devOrigin.port === "1355"
        && (devOrigin.hostname === `${devName}.localhost` || devOrigin.hostname.endsWith(`.${devName}.localhost`));
      const allowedOrigin = !origin || (trustedUrl(origin) && parsedOrigin?.origin === requestUrl.origin) || allowedDevOrigin;
      const callbackRequest = c.req.method === "GET" && requestUrl.hostname === "127.0.0.1"
        && Number(requestUrl.port) === (Number(process.env.SERVER_PORT) || 3117)
        && requestUrl.pathname === "/api/online/auth/callback";
      if (!trustedUrl(c.req.url) || !allowedOrigin || (fetchSite === "cross-site" && !callbackRequest)) {
        return c.json({ ok: false, error: { code: "invalid_request", retryable: false, retryAfter: null }, state: await port.getState() } satisfies OnlineCommandResult, 400);
      }
      if (c.req.method !== "GET" && c.req.method !== "OPTIONS" && !/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
        return c.json({ ok: false, error: { code: "invalid_request", retryable: false, retryAfter: null }, state: await port.getState() } satisfies OnlineCommandResult, 400);
      }
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError(async (error, c) => {
      const invalid = error instanceof HTTPException && error.status === 400;
      return c.json({ ok: false, error: { code: invalid ? "invalid_request" : "internal_error", retryable: false, retryAfter: null }, state: await port.getState() } satisfies OnlineCommandResult, invalid ? 400 : 500);
    })
    .get("/api/online/auth/callback", async (c) => {
      if (c.req.header("Host") !== `127.0.0.1:${Number(process.env.SERVER_PORT) || 3117}`) return c.text("Sign-in could not be completed. Return to RaceIQ.", 400);
      let handled = false;
      try { handled = await port.handleAuthCallback(c.req.url); } catch { /* Keep browser response generic. */ }
      return c.html(`<!doctype html><meta charset="utf-8"><title>RaceIQ sign-in</title><p>${handled ? "Sign-in completed. Return to RaceIQ." : "Sign-in could not be completed. Return to RaceIQ."}</p>`, handled ? 200 : 400);
    })
    .get("/api/online/state", async (c) => c.json(await port.getState()))
    .post("/api/online/connect", validate(connect), async (c) => {
      const result = await port.connect(c.req.valid("json"));
      return c.json(result, result.ok ? 202 : onlineErrorStatus(result.error.code));
    })
    .post("/api/online/connect/cancel", validate(cancel), async (c) => {
      const result = await port.cancelSignIn(c.req.valid("json"));
      return c.json(result, result.ok ? 200 : onlineErrorStatus(result.error.code));
    })
    .put("/api/online/consent", validate(consent), async (c) => {
      const result = await port.acceptConsent(c.req.valid("json"));
      return c.json(result, result.ok ? 200 : onlineErrorStatus(result.error.code));
    })
    .put("/api/online/preferences", validate(preferenceInput), async (c) => {
      const result = await port.setPreferences(c.req.valid("json"));
      return c.json(result, result.ok ? 200 : result.error.code === "preferences_failed" && !result.error.retryable ? 500 : onlineErrorStatus(result.error.code));
    })
    .post("/api/online/sign-out", validate(context), async (c) => {
      const result = await port.signOut(c.req.valid("json"));
      return c.json(result, result.ok ? 200 : onlineErrorStatus(result.error.code));
    })
    .get("/api/online/leaderboard", zValidator("query", board, (result, c) => {
      if (!result.success) return c.json({
        key: { gameId: c.req.header("X-Game-Id") ?? "", trackId: c.req.query("trackId") ?? "", carId: c.req.query("carId") ?? "" },
        status: "unavailable" as const, rows: [], fetchedAt: null, stale: false,
        error: { code: "invalid_request" as const, retryable: false, retryAfter: null },
      }, 400);
    }), async (c) => {
      const gameId = c.req.header("X-Game-Id");
      const key = { gameId: gameId ?? "", ...c.req.valid("query") };
      if (!gameId || !id.safeParse(gameId).success) return c.json({ key, status: "unavailable" as const, rows: [], fetchedAt: null, stale: false, error: { code: "invalid_request" as const, retryable: false, retryAfter: null } }, 400);
      return c.json(await port.getLeaderboard(key));
    });
}

// The getter defers storage initialization until an Online route is actually used.
const port: RaceIqOnlinePort & { handleAuthCallback(url: string): Promise<boolean> } = {
  getState: () => getOnlineService().getState(),
  connect: (input) => getOnlineService().connect(input),
  cancelSignIn: (input) => getOnlineService().cancelSignIn(input),
  acceptConsent: (input) => getOnlineService().acceptConsent(input),
  setPreferences: (input) => getOnlineService().setPreferences(input),
  signOut: (input) => getOnlineService().signOut(input),
  getLeaderboard: (input) => getOnlineService().getLeaderboard(input),
  handleAuthCallback: (url) => getOnlineService().handleAuthCallback(url),
};
export const onlineRoutes = createOnlineRoutes(port);
export type OnlineRoutes = typeof onlineRoutes;
