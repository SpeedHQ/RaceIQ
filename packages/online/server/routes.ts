import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { RaceIqOnlinePort,OnlineCommandResult } from "../contracts/index";
import type { OnlineWorkerPort } from "./worker-protocol";
import { onlineAuthPage } from "./auth-page";
import { createOnlineDataRoutes } from "./data-routes";
import { onlineErrorStatus } from "./errors";

const id = z.string().min(1).max(512);
const context = z.object({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), accountEpoch: id }).strict();
const versions = z.object({ termsVersion: id, privacyVersion: id }).strict();
const preferences = z.object({ visibility: z.enum(["private", "public"]), setupUploads: z.boolean() }).strict();
const consent = context.extend({ acceptedPolicyVersions: versions });
const preferenceInput = context.extend({ preferences });
const displayName = context.extend({ displayName: z.string().refine((value) => {
  const trimmed = value.trim();
  if (!trimmed || /\p{Cc}/u.test(trimmed)) return false;
  let codePoints = 0;
  for (const _character of trimmed) if (++codePoints > 80) return false;
  return true;
}) });
const cancel = context.extend({ flowId: id });
const board = z.object({ trackId: id, carId: id }).strict();


const trustedHosts: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "raceiq.localhost": true };
function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Object.hasOwn(trustedHosts, url.hostname) && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

/** The factory also allows isolated runtime verification without replacing production handlers. */
type OnlineRoutePort = RaceIqOnlinePort & { handleAuthCallback(url: string): Promise<boolean> };
export function createOnlineRoutes(port: OnlineRoutePort, options: { isDev: boolean; serverPort: number } = { isDev: process.env.NODE_ENV !== "production", serverPort: Number(process.env.SERVER_PORT) || 3117 }) {
  const validate = <T extends z.ZodType>(schema: T) => zValidator("json", schema, async (result, c) => {
    if (!result.success) return c.json({ ok: false, error: { code: "invalid_request", retryable: false, retryAfter: null }, state: await port.getState() } satisfies OnlineCommandResult, 400);
  });
  return new Hono()
    .use("/api/*", async (c, next) => {
      if (!c.req.path.startsWith("/api/online/") && c.req.path!=="/api/driver-bindings" && c.req.path!=="/api/driver-summary") return next();
      const requestUrl = new URL(c.req.url);
      const origin = c.req.header("Origin");
      const fetchSite = c.req.header("Sec-Fetch-Site");
      // Same-origin desktop traffic and explicitly known local dev origins only.
      // Never reflect arbitrary origins inherited from the app's development CORS.
      let parsedOrigin: URL | null = null;
      if (origin) {
        try { parsedOrigin = new URL(origin); } catch { throw new HTTPException(400); }
      }
      const devOrigin = parsedOrigin && options.isDev ? parsedOrigin : null;
      const devName = process.env.RACEIQ_DEV_PORTLESS_NAME ?? "raceiq";
      const allowedDevOrigin = devOrigin?.protocol === "http:" && devOrigin.port === "1355"
        && (devOrigin.hostname === `${devName}.localhost` || devOrigin.hostname.endsWith(`.${devName}.localhost`));
      const allowedOrigin = !origin || (trustedUrl(origin) && parsedOrigin?.origin === requestUrl.origin) || allowedDevOrigin;
      const callbackRequest = c.req.method === "GET" && requestUrl.hostname === "127.0.0.1"
        && Number(requestUrl.port) === options.serverPort
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
    .onError((cause, c) => {
      const code = cause instanceof Error && "code" in cause && cause.code==="stale_state" ? "stale_state"
        : cause instanceof HTTPException && cause.status===400 ? "invalid_request" : "service_unavailable";
      return c.json({ok:false,error:{code,retryable:code==="service_unavailable",retryAfter:null}},onlineErrorStatus(code));
    })
    .get("/api/online/auth/callback", async (c) => {
      const nonce = crypto.randomUUID();
      c.header("Referrer-Policy", "no-referrer");
      c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      c.header("X-Content-Type-Options", "nosniff");
      if (c.req.header("Host") !== `127.0.0.1:${options.serverPort}`) return c.html(onlineAuthPage(false, nonce), 400);
      let handled = false;
      try { handled = await port.handleAuthCallback(c.req.url); } catch { /* Keep browser response generic. */ }
      return c.html(onlineAuthPage(handled, nonce), handled ? 200 : 400);
    })
    .get("/api/online/state", async (c) => c.json(await port.getState()))
    .post("/api/online/connect", validate(context), async (c) => {
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
    .put("/api/online/profile", validate(displayName), async (c) => {
      const result = await port.setDisplayName(c.req.valid("json"));
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
export function createOnlineApplicationRoutes(
  port: OnlineRoutePort,
  dataPort: OnlineWorkerPort,
  options?: { isDev: boolean; serverPort: number },
) {
  return createOnlineRoutes(port, options).route("/", createOnlineDataRoutes(dataPort));
}
