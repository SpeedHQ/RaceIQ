import { Hono } from "hono";
import { getCacheStats } from "../db/telemetry-replay-storage";

export const cacheRoutes = new Hono()
  .get("/api/cache/status", (c) => c.json(getCacheStats()));
