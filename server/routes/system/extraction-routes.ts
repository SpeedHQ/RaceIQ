import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Hono } from "hono";

import { scanRecordedFiles } from "../../../shared/racing/tracks/recording/outlines";
import {
  extractionState,
  FM2023_OUT_DIR,
  runForzaExtraction,
} from "../../games/fm-2023/extraction";
import {
  f1ExtractionState,
  F1_25_OUT_DIR,
  runF1Extraction,
} from "../../games/f1-2025/extraction";

export const extractionRoutes = new Hono()
  // GET /api/extraction/status — FM2023 extraction status
  .get("/api/extraction/status", (c) => {
    return c.json(extractionState);
  })

  // POST /api/extraction/run — start FM2023 extraction
  .post("/api/extraction/run", async (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runForzaExtraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/data — delete FM2023 extracted data
  .delete("/api/extraction/data", (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(FM2023_OUT_DIR)) {
      rmSync(FM2023_OUT_DIR, { recursive: true, force: true });
      mkdirSync(FM2023_OUT_DIR, { recursive: true });
    }
    extractionState.status = "idle";
    extractionState.extracted = 0;
    extractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  })

  // GET /api/extraction/f1/status — F1 extraction status
  .get("/api/extraction/f1/status", (c) => {
    return c.json(f1ExtractionState);
  })

  // POST /api/extraction/f1/run — start F1 extraction
  .post("/api/extraction/f1/run", async (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runF1Extraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/f1/data — delete F1 extracted data
  .delete("/api/extraction/f1/data", (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(F1_25_OUT_DIR)) {
      rmSync(F1_25_OUT_DIR, { recursive: true, force: true });
      mkdirSync(F1_25_OUT_DIR, { recursive: true });
    }
    f1ExtractionState.status = "idle";
    f1ExtractionState.extracted = 0;
    f1ExtractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  });
