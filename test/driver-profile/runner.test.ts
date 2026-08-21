import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { driverProfilerAgent } from "../../server/ai/agents";
import * as DriverProfileQueries from "../../server/db/driver-profile-queries";
import type { DriverProfileRunRow } from "../../server/db/driver-profile-queries";
import * as LapReadQueries from "../../server/db/lap-read-queries";
import {
  DRIVER_PROFILE_DEFAULT_OUTPUT_TOKENS,
  driverProfilePoolKey,
  getDriverProfileRunStatus,
  logDriverProfileFailure,
  logDriverProfileOutput,
  notifyDriverProfileLap,
  resetDriverProfileRunnerForTests,
  runDriverProfile,
} from "../../server/driver-profile/runner";
import { driverRoutes } from "../../server/routes/driver-routes";
import { lap } from "../support/driver-profile/factories";

describe("driver profile runner", () => {
  test("background lap notification accepts only game scope", () => {
    const result = notifyDriverProfileLap("fm-2023");
    expect(result).toBeUndefined();
  });

  test("provider configuration remains ready when background scheduling is off", async () => {
    const settingsPath = `${process.env.DATA_DIR ?? "./data"}/settings.json`;
    const original = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
    writeFileSync(settingsPath, JSON.stringify({ driverProfileProvider: "local", driverProfileModel: "test-model", driverProfileBackgroundEnabled: false }));
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

  test("pool key covers the full current evidence identity independent of order", () => {
    const pool = Array.from({ length: 65 }, (_, index) => lap(1000 - index));
    const replaceGeneration = (index: number) => {
      const source = pool[index]!;
      const qualityGeneration = `sha256:rebuilt-${source.id}`;
      return {
        ...source,
        qualityGeneration,
        quality: {
          ...source.quality!,
          provenance: { ...source.quality!.provenance, outputGeneration: qualityGeneration },
        },
      };
    };

    expect(driverProfilePoolKey(pool, "fm-2023")).toBe(driverProfilePoolKey([...pool].reverse(), "fm-2023"));
    expect(driverProfilePoolKey(pool, "fm-2023")).not.toBe(driverProfilePoolKey([replaceGeneration(0), ...pool.slice(1)], "fm-2023"));
    expect(driverProfilePoolKey(pool, "fm-2023")).not.toBe(driverProfilePoolKey([...pool.slice(0, 64), replaceGeneration(64)], "fm-2023"));
  });

  test("pool key changes when stale or manual evidence becomes current again", () => {
    const current = lap(1);
    const stale = { ...current, qualityStale: true };
    const manualExcluded = { ...current, experimentExcluded: true, experimentExcludedSource: "manual" as const };
    const manuallyIncluded = { ...current, experimentExcluded: false, experimentExcludedSource: "manual" as const };

    expect(driverProfilePoolKey([stale], "fm-2023")).not.toBe(driverProfilePoolKey([current], "fm-2023"));
    expect(driverProfilePoolKey([manualExcluded], "fm-2023")).not.toBe(driverProfilePoolKey([manuallyIncluded], "fm-2023"));
  });

  test("status hides stale success and lazily schedules current pool without calling model", async () => {
    const settingsPath = `${process.env.DATA_DIR ?? "./data"}/settings.json`;
    const original = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
    const currentLaps = Array.from({ length: 4 }, (_, index) => lap(index + 1));
    const currentPoolKey = driverProfilePoolKey(currentLaps, "fm-2023");
    const row = (id: number, poolKey: string, status: DriverProfileRunRow["status"]): DriverProfileRunRow => ({
      id,
      scopeKey: "fm-2023|*|*",
      gameId: "fm-2023",
      carOrdinal: null,
      trackOrdinal: null,
      poolKey,
      status,
      fingerprint: null,
      plan: null,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      model: "test-model",
      createdAt: "2026-08-16T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    });
    const staleSuccess = row(1, "old-pool", "succeeded");
    const queuedCurrent = row(2, currentPoolKey, "queued");
    const listRuns = spyOn(DriverProfileQueries, "listDriverProfileRuns").mockResolvedValue([staleSuccess]);
    const findRun = spyOn(DriverProfileQueries, "findDriverProfileRunByScopePool")
      .mockResolvedValueOnce(null)
      .mockResolvedValue(queuedCurrent);
    const getLaps = spyOn(LapReadQueries, "getLapMetaForProfileScope").mockResolvedValue(currentLaps);
    const generate = spyOn(driverProfilerAgent, "generate");
    writeFileSync(settingsPath, JSON.stringify({ driverProfileProvider: "local", driverProfileModel: "test-model", driverProfileBackgroundEnabled: true }));
    resetDriverProfileRunnerForTests();

    try {
      const status = await getDriverProfileRunStatus({ gameId: "fm-2023" });
      expect(status).toMatchObject({ state: "queued", enabled: true, configured: true, latest: null });
      expect(status.runs).toEqual([staleSuccess]);
      await runDriverProfile({ gameId: "fm-2023" });
      expect(generate).not.toHaveBeenCalled();
    } finally {
      resetDriverProfileRunnerForTests();
      listRuns.mockRestore();
      findRun.mockRestore();
      getLaps.mockRestore();
      generate.mockRestore();
      if (original === null) writeFileSync(settingsPath, "{}\n");
      else writeFileSync(settingsPath, original);
    }
  });
  test("logs handled profile failures with run and model context", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      logDriverProfileFailure(5, "qwen/qwen3.5-9b", "Model output did not match summary schema.");
      expect(error).toHaveBeenCalledWith("[AI] Driver profile run 5 failed (model=qwen/qwen3.5-9b): Model output did not match summary schema.");
    } finally {
      error.mockRestore();
    }
  });
  test("uses a 5k output budget for reasoning models", () => {
    expect(DRIVER_PROFILE_DEFAULT_OUTPUT_TOKENS).toBe(5_000);
  });
  test("logs rejected raw model output", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      logDriverProfileOutput(6, "qwen/qwen3.5-9b", { text: "", object: { headline: "x", extra: true } });
      expect(error).toHaveBeenCalledWith('[AI] Driver profile run 6 raw output (model=qwen/qwen3.5-9b, finishReason=<unknown>, usage=<none>, resultKeys=text,object): {"headline":"x","extra":true}');
    } finally {
      error.mockRestore();
    }
  });
});
