import { Hono } from "hono";
import { serverReleaseFeatures } from "../../runtime/config/release-features";
import { createRuntimeFeaturesRoutes } from "./runtime-features";

import { updateRoutes } from "./update-routes";
import { networkRoutes } from "./network-routes";
import { telemetryHistoryRoutes } from "./telemetry-history-routes";
import { extractionRoutes } from "./extraction-routes";
import { diagnosticsRoutes } from "./diagnostics-routes";
import { storageRoutes } from "./storage-routes";

export const miscRoutes = new Hono()
  .route("/", createRuntimeFeaturesRoutes(serverReleaseFeatures))
  .route("/", updateRoutes)
  .route("/", networkRoutes)
  .route("/", telemetryHistoryRoutes)
  .route("/", extractionRoutes)
  .route("/", diagnosticsRoutes)
  .route("/", storageRoutes);
