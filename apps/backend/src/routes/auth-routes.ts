import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { LOCALE_CODES } from "@raceiq/shared/platform/i18n/locales";
import { AccessError, availableInterfaces, getDashboardAuth, NetworkSchema } from "../runtime/dashboard-auth";
import { httpAccess } from "../runtime/http-access";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";

const ChoiceSchema = z.object({ password: z.string().max(1024).nullable(), exposureConfirmed: z.boolean(), language: z.enum(LOCALE_CODES as [string, ...string[]]).optional() });
export const authRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.code }, error.status as 400 | 401 | 409 | 429);
    return c.json({ error: "access_unavailable" }, 503);
  })
  .use("/api/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    try {
      await next();
    } catch (error) {
      if (error instanceof AccessError) return c.json({ error: error.code }, error.status as 400 | 401 | 409 | 429);
      throw error;
    }
  })
  .get("/api/auth/status", async (c) => {
    const auth = getDashboardAuth();
    const status = await auth.status(c.req.raw);
    // Authentication polling must not synchronously query the Windows registry
    // and stall telemetry processing. Launch-on-login is unrelated to auth.
    const settings = loadSettings({ syncLaunchOnLogin: false });
    const network = status.authenticated ? await auth.getNetwork() : null;
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
    await auth.setup(body.password, body.exposureConfirmed);
    if (body.language) saveSettings({ ...loadSettings({ syncLaunchOnLogin: false }), language: body.language });
    if (await auth.isProtected()) {
      const session = await auth.issueSession(c.req.raw);
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
    await auth.changePassword(body.currentPassword, body.password, body.exposureConfirmed);
    if (await auth.isProtected()) {
      const session = await auth.issueSession(c.req.raw);
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
