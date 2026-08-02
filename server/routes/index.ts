import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorLogger } from "../runtime/logger";
import { IS_DEV } from "../runtime/config/env";

import { settingsRoutes } from "./settings-routes";
import { lapRoutes } from "./laps";
import { driverRoutes } from "./driver-routes";
import { chatsRoutes } from "./chats-routes";
import { chatRunRoutes } from "./chat-run-routes";
import { sessionRoutes } from "./session-routes";
import { trackRoutes } from "./tracks";
import { carRoutes } from "./car-routes";
import { tuneRoutes } from "./tune-routes";
import { accRoutes } from "./games/acc";
import { acEvoRoutes } from "./games/ac-evo";
import { f125Routes } from "./games/f1-2025";
import { miscRoutes } from "./system";
import { cacheRoutes } from "./cache-routes";
import { devRoutes } from "./dev";

const app = new Hono()
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
  .use("/*", errorLogger())
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

// Dev-only routes (only in development)
if (IS_DEV) {
  app.route("/", devRoutes);
}

export type AppType = typeof app;
export default app;
