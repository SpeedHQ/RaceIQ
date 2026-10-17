import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { iracingCaptureManager } from "../../runtime/iracing-capture";
import { IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { getIRacingIncidentReport } from "../../games/iracing-incident-report";

export const iracingRoutes = new Hono()
  .get("/api/iracing/sessions/:id/incidents", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const report = await getIRacingIncidentReport(id);
      return report === null ? c.json({ error: "Session not found" }, 404) : c.json(report);
    } catch (error) {
      console.error("[iRacing incidents] Could not read session report", { sessionId: id, error });
      return c.json({ error: "Incident report could not be read" }, 500);
    }
  })
  .get("/api/iracing/capture", (c) => c.json(iracingCaptureManager.status()))
  .put("/api/iracing/capture", zValidator("json", z.object({ connected: z.boolean() }).strict()), async (c) => {
    const { connected } = c.req.valid("json");
    return c.json(await iracingCaptureManager.connect(connected));
  });
