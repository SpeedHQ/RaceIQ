import { Hono } from "hono";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../games/init";
import { importRoutes } from "./import-routes";
import { recordingPacketRoutes, recordingRoutes } from "./recording-routes";

// Initialize game adapters on module load, exactly once for the dev route tree.
initGameAdapters();
initServerGameAdapters();

// Keep registration order identical to the former monolithic router.
export const devRoutes = new Hono()
  .route("/", recordingRoutes)
  .route("/", importRoutes)
  .route("/", recordingPacketRoutes);
