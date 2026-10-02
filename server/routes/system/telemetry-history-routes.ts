import { Hono } from "hono";

import { lapDetector } from "../../telemetry/live-pipeline";
import { wsManager } from "../../runtime/websocket-manager";

export const telemetryHistoryRoutes = new Hono()
  // GET /api/fuel-history
  .get("/api/fuel-history", (c) => {
    return c.json(lapDetector.fuelHistory);
  })

  // GET /api/tire-wear-history
  .get("/api/tire-wear-history", (c) => {
    return c.json(lapDetector.tireWearHistory);
  })

  // GET /api/grip-history
  .get("/api/grip-history", (c) => {
    return c.json(wsManager.getGripHistory());
  })

  // GET /api/telemetry-history
  .get("/api/telemetry-history", (c) => {
    return c.json(wsManager.getTelemetryHistory());
  })

