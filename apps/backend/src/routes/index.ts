import { Hono } from "hono";
import type { BlankEnv, ExtractSchema } from "hono/types";
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
import { trackRoutes } from "@raceiq/tracks-catalogue/server";
import { carRoutes, accCarRoutes, acEvoCarRoutes } from "@raceiq/cars-catalogue/server";
import { tuneRoutes } from "./tune-routes";
import { accRoutes } from "./games/acc";
import { acEvoRoutes } from "./games/ac-evo";
import { lmuSetupRoutes } from "./games/lmu-setups";
import { f125Routes } from "./games/f1-2025";
import { miscRoutes } from "./system/index";
import { cacheRoutes } from "./cache-routes";
import { devRoutes } from "./dev/index";
import { dashboardRoutes } from "./dashboard-routes";

// Name each already-checked schema so declaration generation does not expand
// the entire nested route chain. Keep every mounted production route here.
type AppSchema =
  & ExtractSchema<typeof lmuSetupRoutes>
  & ExtractSchema<typeof settingsRoutes>
  & ExtractSchema<typeof lapRoutes>
  & ExtractSchema<typeof driverRoutes>
  & ExtractSchema<typeof chatsRoutes>
  & ExtractSchema<typeof chatRunRoutes>
  & ExtractSchema<typeof dashboardRoutes>
  & ExtractSchema<typeof sessionRoutes>
  & ExtractSchema<typeof trackRoutes>
  & ExtractSchema<typeof carRoutes>
  & ExtractSchema<typeof tuneRoutes>
  & ExtractSchema<typeof accRoutes>
  & ExtractSchema<typeof acEvoRoutes>
  & ExtractSchema<typeof f125Routes>
  & ExtractSchema<typeof miscRoutes>
  & ExtractSchema<typeof cacheRoutes>;

const app = new Hono<BlankEnv, AppSchema>()
  .use("/*", async (c, next) => {
    const denied = await httpAccess.authorize(c.req.raw);
    if (denied) return denied;
    if (httpAccess.usesSessions) c.header("Cache-Control", "no-store");
    await next();
  })
  .use(
    "/*",
    cors({
      origin: (origin, c) => (httpAccess.allowsOrigin(origin, c.req.raw) ? origin : ""),
      credentials: true,
      exposeHeaders: ["X-RaceIQ-CSRF"],
      // Studio needs its own headers; reflect them only for trusted origins.
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .use("/*", errorLogger())
  .route("/", authRoutes)
  .route("/", lmuSetupRoutes)
  .route("/", settingsRoutes)
  .route("/", lapRoutes)
  .route("/", driverRoutes)
  .route("/", chatsRoutes)
  .route("/", chatRunRoutes)
  .route("/", dashboardRoutes)
  .route("/", sessionRoutes)
  .route("/", trackRoutes)
  .route("/", carRoutes)
  .route("/", tuneRoutes)
  .route("/", accCarRoutes)
  .route("/", accRoutes)
  .route("/", acEvoCarRoutes)
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
