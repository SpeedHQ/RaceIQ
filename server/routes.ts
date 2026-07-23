import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorLogger } from "./logger";
import { IS_DEV } from "./env";

import { settingsRoutes } from "./routes/settings-routes";
import { lapRoutes } from "./routes/lap-routes";
import { chatsRoutes } from "./routes/chats-routes";
import { chatRunRoutes } from "./routes/chat-run-routes";
import { sessionRoutes } from "./routes/session-routes";
import { trackRoutes } from "./routes/track-routes";
import { carRoutes } from "./routes/car-routes";
import { tuneRoutes } from "./routes/tune-routes";
import { accRoutes } from "./routes/acc-routes";
import { acEvoRoutes } from "./routes/ac-evo-routes";
import { f125Routes } from "./routes/f125-routes";
import { miscRoutes } from "./routes/misc-routes";
import { cacheRoutes } from "./routes/cache-routes";
import { devRoutes } from "./routes/dev-routes";

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
