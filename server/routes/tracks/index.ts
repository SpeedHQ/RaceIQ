import { Hono } from "hono";
import { trackCatalogInfoRoutes, trackCatalogRoutes } from "./catalog-routes";
import { trackCornerRoutes, trackSectorBoundaryRoutes, trackSegmentRoutes } from "./segments-routes";
import { trackLapSectorRoutes, trackOutlineRoutes, trackRecomputeOutlineRoutes } from "./outline-routes";
import { trackLeaderboardRoutes } from "./leaderboard-routes";
import { trackCalibrationRoutes, trackGeometryRoutes } from "./geometry-routes";
import { trackImageryRoutes } from "./imagery-routes";

// Keep registration order identical to the former monolithic router.
export const trackRoutes = new Hono()
  .route("/", trackCornerRoutes)
  .route("/", trackCatalogInfoRoutes)
  .route("/", trackSectorBoundaryRoutes)
  .route("/", trackCatalogRoutes)
  .route("/", trackImageryRoutes)
  .route("/", trackSegmentRoutes)
  .route("/", trackRecomputeOutlineRoutes)
  .route("/", trackLeaderboardRoutes)
  .route("/", trackCalibrationRoutes)
  .route("/", trackLapSectorRoutes)
  .route("/", trackOutlineRoutes)
  .route("/", trackGeometryRoutes);
