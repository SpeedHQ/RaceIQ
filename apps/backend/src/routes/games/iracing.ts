import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { iracingCaptureManager } from "../../runtime/iracing-capture";

export const iracingRoutes = new Hono()
  .get("/api/iracing/capture", (c) => c.json(iracingCaptureManager.status()))
  .put("/api/iracing/capture", zValidator("json", z.object({ connected: z.boolean() }).strict()), async (c) => {
    const { connected } = c.req.valid("json");
    return c.json(await iracingCaptureManager.connect(connected));
  });
