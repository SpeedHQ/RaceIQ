import { Hono } from "hono";

import { tuneAutoRoutes } from "./auto-routes";
import { tuneResourceRoutes } from "./resource-routes";
import { tuneSetupFileRoutes } from "./setup-file-routes";

// Static setup-file GET routes must be registered before /api/tunes/:id.
export const tuneCrudRoutes = new Hono()
  .route("/", tuneSetupFileRoutes)
  .route("/", tuneResourceRoutes)
  .route("/", tuneAutoRoutes);
