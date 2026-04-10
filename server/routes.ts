import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorLogger } from "./logger";
import { IS_DEV } from "./env";

import { settingsRoutes } from "./routes/settings-routes";
import { lapRoutes } from "./routes/lap-routes";
import { sessionRoutes } from "./routes/session-routes";
import { trackRoutes } from "./routes/track-routes";
import { carRoutes } from "./routes/car-routes";
import { tuneRoutes } from "./routes/tune-routes";
import { accRoutes } from "./routes/acc-routes";
import { f125Routes } from "./routes/f125-routes";
import { miscRoutes } from "./routes/misc-routes";
import { devRoutes } from "./routes/dev-routes";

const app = new Hono()
  .use("/*", cors())
  .use("/*", errorLogger())
  .route("/", settingsRoutes)
  .route("/", lapRoutes)
  .route("/", sessionRoutes)
  .route("/", trackRoutes)
  .route("/", carRoutes)
  .route("/", tuneRoutes)
  .route("/", accRoutes)
  .route("/", f125Routes)
  .route("/", miscRoutes);

// Dev-only routes (only in development)
if (IS_DEV) {
  app.route("/", devRoutes);
}

export type AppType = typeof app;
export default app;
