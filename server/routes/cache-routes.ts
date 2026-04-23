import { Hono } from "hono";
import { getCacheStats } from "../db/queries";

export const cacheRoutes = new Hono()
  .get("/api/cache/status", (c) => c.json(getCacheStats()));
