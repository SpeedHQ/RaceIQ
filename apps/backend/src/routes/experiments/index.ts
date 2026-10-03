import { Hono } from "hono";
import { experimentDetailRoutes, experimentLifecycleRoutes } from "./lifecycle-routes";
import { experimentHeadRoutes, experimentVersionRoutes } from "./version-routes";
import { experimentLapAnalysisRoutes, experimentLapRoutes } from "./lap-routes";
import { experimentHistoryRoutes } from "./history-routes";
import { experimentComparisonRoutes } from "./comparison-routes";

export const experimentRoutes = new Hono()
  .route("/", experimentLifecycleRoutes)
  .route("/", experimentVersionRoutes)
  .route("/", experimentLapRoutes)
  .route("/", experimentHeadRoutes)
  .route("/", experimentHistoryRoutes)
  .route("/", experimentLapAnalysisRoutes)
  .route("/", experimentComparisonRoutes)
  .route("/", experimentDetailRoutes);
