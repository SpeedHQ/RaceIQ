import { describe, expect, test } from "bun:test";
import { createRuntimeFeaturesRoutes } from "../../server/routes/system/runtime-features";

describe("runtime feature route", () => {
  test("returns resolved feature booleans exactly", async () => {
    const features = {
      f1Experiments: true,
      iracingAdapter: false,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"] as const,
    };
    const response = await createRuntimeFeaturesRoutes(features).request(
      "http://localhost/api/runtime/features",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(features);
  });
});
