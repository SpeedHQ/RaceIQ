import { describe, expect, test } from "bun:test";
import { createRuntimeFeaturesRoutes } from "../../server/routes/system/runtime-features";

describe("runtime feature route", () => {
  test("returns resolved feature booleans exactly", async () => {
    const response = await createRuntimeFeaturesRoutes({ f1Experiments: true, iracingAdapter: false }).request(
      "http://localhost/api/runtime/features",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ f1Experiments: true, iracingAdapter: false });
  });
});
