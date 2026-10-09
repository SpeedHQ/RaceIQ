import { Hono } from "hono";
import type { BlankEnv, ExtractSchema } from "hono/types";
import { cors } from "hono/cors";
import { errorLogger } from "@raceiq/backend-core/runtime/logger";
import { IS_DEV, IS_E2E } from "@raceiq/backend-core/runtime/config/env";

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

// Name each already-checked schema so declaration generation does not expand
// the entire nested route chain. Keep every mounted production route here.
type AppSchema =
  & ExtractSchema<typeof lmuSetupRoutes>
  & ExtractSchema<typeof settingsRoutes>
  & ExtractSchema<typeof lapRoutes>
  & ExtractSchema<typeof driverRoutes>
  & ExtractSchema<typeof chatsRoutes>
  & ExtractSchema<typeof chatRunRoutes>
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
  // In dev, Mastra Studio (localhost:3000) probes /studio-api/auth/capabilities
  // with `credentials: "include"`; browsers reject a wildcard ACAO on
  // credentialed requests, so reflect the request origin + allow credentials.
  // Prod keeps the plain wildcard (the desktop client is same-origin).
  .use(
    "/*",
    IS_DEV
      ? cors({
          origin: (origin) => origin ?? "*",
          credentials: true,
          // Omit allowHeaders so Hono reflects the browser's
          // Access-Control-Request-Headers verbatim. Mastra Studio's client
          // sends its own headers (e.g. x-mastra-client-type) on /studio-api
          // requests; a static allow-list drops them and the credentialed
          // preflight fails with "Failed to fetch".
          allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        })
      : cors(),
  )
  .use("/*", errorLogger());

app.route("/", lmuSetupRoutes);
app.route("/", settingsRoutes);
app.route("/", lapRoutes);
app.route("/", driverRoutes);
app.route("/", chatsRoutes);
app.route("/", chatRunRoutes);
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
