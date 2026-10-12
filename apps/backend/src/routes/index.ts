import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorLogger } from "@raceiq/backend-core/runtime/logger";
import { IS_DEV, IS_E2E } from "@raceiq/backend-core/runtime/config/env";
import { httpAccess } from "../runtime/http-access";

import { settingsRoutes } from "./settings-routes";
import { authRoutes } from "./auth-routes";
import { lapRoutes } from "./laps/index";
import { driverRoutes } from "./driver-routes";
import { chatsRoutes } from "./chats-routes";
import { chatRunRoutes } from "./chat-run-routes";
import { sessionRoutes } from "./session-routes";
import { trackRoutes } from "./tracks/index";
import { carRoutes } from "./car-routes";
import { tuneRoutes } from "./tune-routes";
import { accRoutes } from "./games/acc";
import { acEvoRoutes } from "./games/ac-evo";
import { f125Routes } from "./games/f1-2025";
import { miscRoutes } from "./system/index";
import { cacheRoutes } from "./cache-routes";
import { devRoutes } from "./dev/index";

const app = new Hono()
  .use("/*", async (c, next) => {
    const denied = httpAccess.authorize(c.req.raw);
    if (denied) return denied;
    if (httpAccess.usesSessions) c.header("Cache-Control", "no-store");
    await next();
  })
  .use(
    "/*",
    cors({
      origin: (origin, c) => httpAccess.allowsOrigin(origin, c.req.raw) ? origin : "",
      credentials: true,
      exposeHeaders: ["X-RaceIQ-CSRF"],
      // Studio needs its own headers; reflect them only for trusted origins.
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .use("/*", errorLogger())
  .route("/", authRoutes)
  .route("/", settingsRoutes)
  .route("/", lapRoutes)
  .route("/", driverRoutes)
  .route("/", chatsRoutes)
.route("/", chatRunRoutes)
  .route("/", sessionRoutes)
  .route("/", trackRoutes)
  .route("/", carRoutes)
  .route("/", tuneRoutes)
  .route("/", accRoutes)
  .route("/", acEvoRoutes)
  .route("/", f125Routes)
  .route("/", miscRoutes)
  .route("/", cacheRoutes);

// Fixture import/replay routes stay unavailable in normal production. Compiled
// Playwright runs opt in explicitly so they exercise the packaged server too.
if (IS_DEV || IS_E2E) {
  app.route("/", devRoutes);
}

export type AppType = typeof app;
export default app;
