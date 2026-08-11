import { Hono } from "hono";

import { lapDetector } from "../../telemetry/live-pipeline";
import { wsManager } from "../../runtime/websocket-manager";
import { extractionState } from "../../games/fm-2023/extraction";
import { f1ExtractionState } from "../../games/f1-2025/extraction";

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

  // GET /api/games/detection — combined game detection status
  .get("/api/games/detection", (c) => {
    return c.json({
      "fm-2023": {
        installed: extractionState.installed,
        extracted:
          extractionState.status === "done" && extractionState.extracted > 0,
        extractionStatus: extractionState.status,
        trackCount: extractionState.extracted,
      },
      "f1-2025": {
        installed: f1ExtractionState.installed,
        extracted:
          f1ExtractionState.status === "done" &&
          f1ExtractionState.extracted > 0,
        extractionStatus: f1ExtractionState.status,
        trackCount: f1ExtractionState.extracted,
      },
    });
  });
