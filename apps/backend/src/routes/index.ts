import { Hono } from "hono";
import type { BlankEnv, ExtractSchema } from "hono/types";
import { cors } from "hono/cors";
import { errorLogger } from "@raceiq/backend-core/runtime/logger";
import { IS_DEV, IS_E2E } from "@raceiq/backend-core/runtime/config/env";
import { httpAccess } from "../runtime/http-access";

import { settingsRoutes } from "./settings-routes";
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
    const denied = httpAccess.authorize(c.req.raw);
    if (denied) return denied;
    await next();
  })
  .use(
    "/*",
    cors({
      origin: (origin, c) => httpAccess.allowsOrigin(origin, c.req.raw) ? origin : "",
      credentials: true,
      // Studio needs its own headers; reflect them only for trusted origins.
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .use("/*", errorLogger());

app.route("/", lmuSetupRoutes);
app.route("/", settingsRoutes);
app.route("/", lapRoutes);
app.route("/", driverRoutes);
app.route("/", chatsRoutes);
app.route("/", chatRunRoutes);
app.route("/", dashboardRoutes);
app.route("/", sessionRoutes);
app.route("/", trackRoutes);
app.route("/", carRoutes);
app.route("/", tuneRoutes);
app.route("/", accRoutes);
app.route("/", acEvoRoutes);
app.route("/", f125Routes);
app.route("/", miscRoutes);
app.route("/", cacheRoutes);

// Fixture import/replay routes stay unavailable in normal production. Compiled
// Playwright runs opt in explicitly so they exercise the packaged server too.
if (IS_DEV || IS_E2E) {
  app.route("/", devRoutes);
}

export type AppType = typeof app;
export default app;
