import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { withOnboardingOverride } from "@raceiq/backend-core/runtime/options";
import { LOCALE_CODES } from "@raceiq/shared/platform/i18n/locales";
import { AccessError, availableInterfaces, getDashboardAuth, NetworkSchema } from "../runtime/dashboard-auth";
import { getHttpAccess } from "../runtime/http-access";
import { resolveOnlinePlatform } from "../integrations/online-platform";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";

const ChoiceSchema = z.object({ password: z.string().max(1024).nullable(), exposureConfirmed: z.boolean(), language: z.enum(LOCALE_CODES as [string, ...string[]]).optional() });
export const authRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.code }, error.status as 400 | 401 | 403 | 409 | 429 | 503);
    return c.json({ error: "access_unavailable" }, 503);
  })
  .use("/api/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    try {
      await next();
    } catch (error) {
      if (error instanceof AccessError) return c.json({ error: error.code }, error.status as 400 | 401 | 403 | 409 | 429 | 503);
      throw error;
    }
  })
  .post("/api/auth/discord/start", zValidator("json", z.object({ language: z.enum(LOCALE_CODES as [string, ...string[]]).optional() })), async (c) => {
    const origin = c.req.header("origin");
    const body = c.req.valid("json");
    if (!origin || !getHttpAccess().allowsOrigin(origin, c.req.raw)) throw new AccessError("invalid_origin", 400);
    const auth = getDashboardAuth();
    if (auth.env.SERVER_PASSWORD) throw new AccessError("environment_override", 409);
    const status = await auth.status(c.req.raw);
    if (status.method === "password" && status.protected) {
      if (!status.authenticated) throw new AccessError("authentication_required", 401);
      if (!status.csrf || c.req.header("x-raceiq-csrf") !== status.csrf) throw new AccessError("csrf_mismatch", 403);
    }
    if (resolveOnlinePlatform().kind === "disabled") return c.json({ error: "development_online_unconfigured" }, 503);
    const previous = /(?:^|;\s*)raceiq_discord_flow=([a-f0-9-]{36,64})(?:;|$)/.exec(c.req.header("cookie") ?? "")?.[1];
    if (previous) await auth.cancelDiscordSignIn(previous);
    const flow = crypto.randomUUID();
    const base = new URL("/api/auth/discord/callback", origin).toString();
    const result = await auth.beginDiscordSignIn({ callbackUrl: base, flow, origin, request: c.req.raw, language: body.language });
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    c.header("Set-Cookie", `raceiq_discord_flow=${flow}; Path=/api/auth/discord; HttpOnly; SameSite=Strict; Max-Age=600${secure ? "; Secure" : ""}`);
    return c.json({ authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt });
  })
  .get("/api/auth/discord/callback", async (c) => {
    const callbackId = c.req.query("flow");
    if (!callbackId || !/^[a-f0-9]{64}$/.test(callbackId)) throw new AccessError("invalid_completion");
    const request = c.req.raw;
    const target = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    let browserOrigin = target.origin;
    if (forwardedHost || forwardedProtocol) {
      if (!forwardedHost || !forwardedProtocol || /[\s,/\\?#@]/.test(forwardedHost) || !["http", "https"].includes(forwardedProtocol)) throw new AccessError("invalid_origin", 400);
      browserOrigin = `${forwardedProtocol}://${forwardedHost}`;
    }
    if (!getHttpAccess().allowsOrigin(browserOrigin, request)) throw new AccessError("invalid_origin", 400);
    target.protocol = `${new URL(browserOrigin).protocol}`;
    target.host = new URL(browserOrigin).host;
    const attempt = await getDashboardAuth().completeDiscordSignIn(callbackId, target.toString());
    return c.redirect(new URL("/login?discord=complete", attempt.origin).toString(), 302);
  })
  .post("/api/auth/discord/finish", zValidator("json", z.object({})), async (c) => {
    const flow = /(?:^|;\s*)raceiq_discord_flow=([a-f0-9-]{36,64})(?:;|$)/.exec(c.req.header("cookie") ?? "")?.[1];
    if (!flow) throw new AccessError("missing_browser_proof", 401);
    const result = await getDashboardAuth().finishDiscordSignIn(flow, c.req.raw);
    if (result.pending) return c.json({ status: "pending" }, 202);
    if (result.language) saveSettings({ ...loadSettings({ syncLaunchOnLogin: false }), language: result.language });
    c.header("Set-Cookie", result.cookie);
    c.header("Set-Cookie", `raceiq_discord_flow=; Path=/api/auth/discord; HttpOnly; SameSite=Strict; Max-Age=0`, { append: true });
    c.header("X-RaceIQ-CSRF", result.csrf);
    return c.json({ status: "complete" });
  })
  .post("/api/auth/discord/cancel", zValidator("json", z.object({})), async (c) => {
    const flow = /(?:^|;\s*)raceiq_discord_flow=([a-f0-9-]{36,64})(?:;|$)/.exec(c.req.header("cookie") ?? "")?.[1];
    if (flow) await getDashboardAuth().cancelDiscordSignIn(flow);
    c.header("Set-Cookie", `raceiq_discord_flow=; Path=/api/auth/discord; HttpOnly; SameSite=Strict; Max-Age=0`);
    return c.json({ ok: true });
  })
  .get("/api/auth/status", async (c) => {
    const auth = getDashboardAuth();
    const status = await auth.status(c.req.raw);
    // Authentication polling must not synchronously query the Windows registry
    // and stall telemetry processing. Launch-on-login is unrelated to auth.
    const settings = withOnboardingOverride(loadSettings({ syncLaunchOnLogin: false }));
    const network = status.authenticated ? await auth.getNetwork() : null;
    const httpAccess = getHttpAccess();
    return c.json({
      ...status,
      language: settings.language,
      onboardingComplete: settings.onboardingComplete,
      features: serverReleaseFeatures,
      network,
      interfaces: status.authenticated ? availableInterfaces() : [],
      activeHosts: status.authenticated ? httpAccess.hosts : [],
      port: httpAccess.port,
      allowedOriginsOverride: status.authenticated ? process.env.SERVER_ALLOWED_ORIGINS || null : null,
    });
  })
  .post("/api/auth/setup", zValidator("json", ChoiceSchema), async (c) => {
    const body = c.req.valid("json");
    const auth = getDashboardAuth();
    const revision = await auth.setup(body.password, body.exposureConfirmed);
    if (body.language) saveSettings({ ...loadSettings({ syncLaunchOnLogin: false }), language: body.language });
    if (await auth.isProtected()) {
      const session = await auth.issueSession(c.req.raw, revision);
      c.header("Set-Cookie", session.cookie);
      c.header("X-RaceIQ-CSRF", session.csrf);
    }
    return c.json({ ok: true });
  })
  .post("/api/auth/login", zValidator("json", z.object({ password: z.string().max(1024) })), async (c) => {
    const session = await getDashboardAuth().login(c.req.valid("json").password, c.req.raw);
    c.header("Set-Cookie", session.cookie);
    c.header("X-RaceIQ-CSRF", session.csrf);
    return c.json({ ok: true });
  })
  .post("/api/auth/logout", async (c) => {
    c.header("Set-Cookie", await getDashboardAuth().logout(c.req.raw));
    c.header("X-RaceIQ-CSRF", "");
    return c.json({ ok: true });
  })
  .put("/api/auth/password", zValidator("json", ChoiceSchema.extend({ currentPassword: z.string().max(1024) })), async (c) => {
    const body = c.req.valid("json");
    const auth = getDashboardAuth();
    const revision = await auth.changePassword(body.currentPassword, body.password, body.exposureConfirmed);
    if (await auth.isProtected()) {
      const session = await auth.issueSession(c.req.raw, revision);
      c.header("Set-Cookie", session.cookie);
      c.header("X-RaceIQ-CSRF", session.csrf);
    } else {
      c.header("Set-Cookie", await auth.logout(c.req.raw));
      c.header("X-RaceIQ-CSRF", "");
    }
    return c.json({ ok: true });
  })
  .put("/api/auth/network", zValidator("json", NetworkSchema), async (c) => {
    await getDashboardAuth().saveNetwork(c.req.valid("json"));
    return c.json({ ok: true, restartRequired: true });
  });
