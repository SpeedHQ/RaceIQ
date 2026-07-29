import { describe, expect, test } from "bun:test";

import { notifyDriverProfileLap } from "../server/ai/driver-profile-runner";
import { driverRoutes } from "../server/routes/driver-routes";

describe("driver profile runner", () => {
  test("background lap notification is a no-op when disabled", () => {
    const result = notifyDriverProfileLap("fm-2023", 42, 7);
    expect(result).toBeUndefined();
  });

  test("run history requires an explicit game header", async () => {
    const response = await driverRoutes.request("/api/drivers/profile/runs");
    expect(response.status).toBe(400);
  });

  test("run history reports disabled background state", async () => {
    const response = await driverRoutes.request("/api/drivers/profile/runs", {
      headers: { "X-Game-Id": "fm-2023" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "disabled", enabled: false, configured: false });
  });
});
