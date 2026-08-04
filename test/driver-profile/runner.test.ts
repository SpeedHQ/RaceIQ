import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";

import { driverProfilePoolKey, notifyDriverProfileLap } from "../../server/driver-profile/runner";
import { driverRoutes } from "../../server/routes/driver-routes";

describe("driver profile runner", () => {
  test("background lap notification accepts only game scope", () => {
    const result = notifyDriverProfileLap("fm-2023");
    expect(result).toBeUndefined();
  });

  test("provider configuration remains ready when background scheduling is off", async () => {
    const settingsPath = `${process.env.DATA_DIR ?? "./data"}/settings.json`;
    const original = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
    writeFileSync(settingsPath, JSON.stringify({ driverProfileProvider: "local", driverProfileBackgroundEnabled: false }));
    try {
      const response = await driverRoutes.request("/api/drivers/profile/runs", {
        headers: { "X-Game-Id": "fm-2023" },
      });
      expect(await response.json()).toMatchObject({ state: "disabled", enabled: false, configured: true });
    } finally {
      if (original === null) writeFileSync(settingsPath, "{}\n");
      else writeFileSync(settingsPath, original);
    }
  });

  test("run history requires an explicit game header", async () => {
    const response = await driverRoutes.request("/api/drivers/profile/runs");
    expect(response.status).toBe(400);
  });

  test("profile GET returns only global fingerprint and game name", async () => {
    const response = await driverRoutes.request("/api/drivers/profile?carOrdinal=42&trackOrdinal=7", {
      headers: { "X-Game-Id": "fm-2023" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["fingerprint", "gameName"]);
  });

  test("run history ignores no scoped identity and reports disabled background state", async () => {
    const response = await driverRoutes.request("/api/drivers/profile/runs?carOrdinal=42&trackOrdinal=7", {
      headers: { "X-Game-Id": "fm-2023" },
    });
    const body = await response.json();
    expect(body).toMatchObject({
      state: "not-configured",
      enabled: false,
      configured: false,
      scope: { gameId: "fm-2023" },
    });
    expect(body.scope).not.toHaveProperty("carOrdinal");
  });

  test("legacy profile generation and delete routes are removed", async () => {
    const headers = { "X-Game-Id": "fm-2023" };
    expect((await driverRoutes.request("/api/drivers/profile", { method: "POST", headers })).status).toBe(404);
    expect((await driverRoutes.request("/api/drivers/profile", { method: "DELETE", headers })).status).toBe(404);
  });

  test("pool key is versioned and includes only newest 60 IDs before sorting", () => {
    const newest = Array.from({ length: 60 }, (_, index) => 1000 - index);
    const withOldTail = [...newest, 1, 2, 3];
    expect(driverProfilePoolKey(newest)).toBe(driverProfilePoolKey(withOldTail));
    expect(driverProfilePoolKey(newest)).not.toBe(driverProfilePoolKey([999, ...newest.slice(1)]));
  });
});
