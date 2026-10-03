import { Hono } from "hono";
import type { ReleaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";

export function createRuntimeFeaturesRoutes(flags: ReleaseFeatureFlags): Hono {
  return new Hono().get("/api/runtime/features", (c) => c.json(flags));
}
