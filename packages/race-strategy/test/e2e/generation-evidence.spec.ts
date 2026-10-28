import { expect, test } from "@playwright/test";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "fm-2023" };
const gameId = "fm-2023";
const carId = "642";
const trackId = "5";

function evidence(sessionId: number, id: string, fuel: number, fuelLaps: number): StintSummary {
  return {
    id, sessionId, driverKey: "local-player", ordinal: 1, status: "completed", gameId, trackId, carId, pi: 800,
    compounds: ["soft", "soft", "soft", "soft"],
    compatibility: {
      fuelSemanticVersion: "fuel-v1", tireSemanticVersions: ["tire-v1", "tire-v1", "tire-v1", "tire-v1"], setupKey: null,
      conditions: { weather: "dry", airTemperatureC: null, trackTemperatureC: null },
    },
    startedAt: "2025-01-01T00:00:00.000Z", endedAt: "2025-01-01T00:10:00.000Z",
    firstLapNumber: 1, lastLapNumber: 10, boundary: { reason: "pit-visit", confidence: "observed" },
    completedLaps: 10,
    fuel: { value: fuel, unit: "L/lap", eligibleLaps: fuelLaps, source: "history", provisional: false, unavailableReason: null },
    tires: [0, 1, 2, 3].map((index) => ({
      value: fuel + index / 1000, unit: "wearFraction/lap", eligibleLaps: fuelLaps + index, source: "history", provisional: false, unavailableReason: null,
    })) as StintSummary["tires"],
    measuredFuelUsed: 0, fuelUnit: "L", fuelCoverage: "complete", averageLapSeconds: 60, paceLaps: 10,
    exclusions: [], algorithmVersion: "generation-evidence-e2e", revision: 1,
  } as StintSummary;
}

test("generation evidence API applies recent-session window, compatibility, weighting and request validation", async ({ playwright }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-generation-evidence"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL, extraHTTPHeaders: headers });
  try {
    await runtime.stop();
    const insertSession = async (name: string, offset: number, capture?: "recording" | "failed", car = carId, game = gameId) => {
      const createdAt = new Date(Date.UTC(2025, 0, 1) - offset * 86_400_000).toISOString();
      await runtime.databaseStatement(
        "INSERT INTO sessions(game_id,car_id,track_id,ownership,raw_file,lap_detector_version,created_at) VALUES(?,?,?,?,?,?,?)",
        [game, car, trackId, "mine", `/${name}.bin`, "generation-evidence-e2e", createdAt], true,
      );
      const row = (await runtime.databaseStatement("SELECT id FROM sessions WHERE raw_file=?", [`/${name}.bin`])) as Array<{ id: number }>;
      const sessionId = row[0]!.id;
      await runtime.databaseStatement(
        "INSERT INTO laps(session_id,lap_number,lap_time,is_valid,created_at) VALUES(?,1,60,1,?)",
        [sessionId, createdAt], true,
      );
      if (capture) {
        await runtime.databaseStatement(
          "INSERT INTO live_captures(session_id,capture_epoch,attempt,source_path,archive_path,status) VALUES(?,?,?,?,?,?)",
          [sessionId, name, name, `/${name}.bin`, `/${name}.archive`, capture], true,
        );
      }
      return sessionId;
    };
    const insertStint = async (sessionId: number, id: string, source: unknown, driver = "local-player", ordinal = 1) => {
      await runtime.databaseStatement(
        "INSERT INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload) VALUES(?,?,?,?,?,?)",
        [id, sessionId, driver, ordinal, "completed", JSON.stringify(source)], true,
      );
    };

    const active = await insertSession("active-newer", 0, "recording");
    await insertStint(active, "active-stint", evidence(active, "active-stint", 99, 99));
    const unsealed = await insertSession("unsealed-newer", 1, "failed");
    await insertStint(unsealed, "unsealed-stint", evidence(unsealed, "unsealed-stint", 99, 99));

    const invalidSession = await insertSession("invalid-window", 2);
    const invalid = { ...evidence(invalidSession, "invalid-stint", 99, 99), tires: [null, null, null, null] };
    await insertStint(invalidSession, "invalid-stint", invalid);

    const valid = [
      { fuel: 0.02, laps: 2 }, { fuel: 0.04, laps: 6 }, { fuel: 0.03, laps: 3 }, { fuel: 0.05, laps: 1 },
    ];
    const accepted: Array<{ sessionId: number; stintId: string; fuel: number; laps: number }> = [];
    for (const [index, item] of valid.entries()) {
      const sessionId = await insertSession(`eligible-${index}`, 3 + index);
      const stintId = `eligible-stint-${index}`;
      await insertStint(sessionId, stintId, evidence(sessionId, stintId, item.fuel, item.laps));
      accepted.push({ sessionId, stintId, ...item });
    }
    const oldest = accepted[3]!;
    const mismatches = [
      { compounds: ["medium", "medium", "medium", "medium"] },
      { pi: 900 },
      { compatibility: { ...evidence(oldest.sessionId, "semantic-fuel", oldest.fuel, oldest.laps).compatibility, fuelSemanticVersion: "other-fuel" } },
      { compatibility: { ...evidence(oldest.sessionId, "semantic-tire", oldest.fuel, oldest.laps).compatibility, tireSemanticVersions: ["other", "other", "other", "other"] } },
      { compatibility: { ...evidence(oldest.sessionId, "setup", oldest.fuel, oldest.laps).compatibility, setupKey: "other-setup" } },
      { fuelUnit: "tankFraction", fuel: { value: 0.1, unit: "tankFraction/lap", eligibleLaps: oldest.laps, source: "history", provisional: false, unavailableReason: null } },
    ];
    for (const [index, mismatch] of mismatches.entries()) {
      const id = `incompatible-${index}`;
      await insertStint(oldest.sessionId, id, { ...evidence(oldest.sessionId, id, oldest.fuel, oldest.laps), ...mismatch }, "local-player", index + 2);
    }
    const opponentId = "opponent-stint";
    await insertStint(oldest.sessionId, opponentId, evidence(oldest.sessionId, opponentId, 0.9, 100), "opponent", mismatches.length + 2);
    const wrongCombo = await insertSession("wrong-combo", 8, undefined, "other-car");
    await insertStint(wrongCombo, "wrong-combo-stint", { ...evidence(wrongCombo, "wrong-combo-stint", 0.9, 100), carId: "other-car" });
    const sixth = await insertSession("sixth-older", 7);
    await insertStint(sixth, "sixth-stint", evidence(sixth, "sixth-stint", 0.9, 100));
    const singleSession = await insertSession("single-zero", 8, undefined, "single-source");
    const singleEvidence = {
      ...evidence(singleSession, "single-zero-stint", 0, 1), carId: "single-source",
      tires: [0, 1, 2, 3].map(() => ({ value: 0, unit: "wearFraction/lap", eligibleLaps: 1, source: "history", provisional: false, unavailableReason: null })),
    };
    await insertStint(singleSession, "single-zero-stint", singleEvidence);
    const lmuSession = await insertSession("lmu-missing-energy", 9, undefined, "lmu-car", "lmu");
    const lmuSummary = {
      ...evidence(lmuSession, "lmu-missing-energy-stint", 0.1, 1),
      gameId: "lmu", carId: "lmu-car", pi: null,
      compatibility: { ...evidence(lmuSession, "lmu-missing-energy-stint", 0.1, 1).compatibility, virtualEnergySemanticVersion: "energy-v1" },
      virtualEnergy: { value: null, unit: "energyFraction/lap", eligibleLaps: 0, source: null, provisional: false, unavailableReason: "no-data" },
    };
    await insertStint(lmuSession, "lmu-missing-energy-stint", lmuSummary);
    await runtime.restart();

    const response = await api.get(`/api/race-plans/generation-evidence?gameId=${gameId}&carId=${carId}&trackId=${trackId}&weather=dry`);
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json();
    const baseline = body.baseline;
    expect(baseline.sources.map((source: { id: string }) => source.id)).toEqual(accepted.map((source) => source.stintId));
    expect(baseline.sources.map((source: { sessionId: number }) => source.sessionId)).toEqual(accepted.map((source) => source.sessionId));
    expect(baseline.fuel.eligibleLaps).toBe(12);
    expect(baseline.fuel.value).toBeCloseTo((0.02 * 2 + 0.04 * 6 + 0.03 * 3 + 0.05) / 12);
    expect(baseline.tires[0].eligibleLaps).toBe(12);
    expect(baseline.tires[1].eligibleLaps).toBe(16);
    expect(baseline.tires[1].value).toBeCloseTo(0.036);
    expect(baseline.tires[0].value).toBeCloseTo(0.035);
    expect(baseline.weather).toBe("dry");

    const emptyWeather = await api.get(`/api/race-plans/generation-evidence?gameId=${gameId}&carId=${carId}&trackId=${trackId}&weather=wet`);
    expect(emptyWeather.ok(), await emptyWeather.text()).toBe(true);
    expect((await emptyWeather.json()).baseline).toBeNull();
    const single = await api.get(`/api/race-plans/generation-evidence?gameId=${gameId}&carId=single-source&trackId=${trackId}&weather=dry`);
    expect(single.ok(), await single.text()).toBe(true);
    const singleBaseline = (await single.json()).baseline;
    expect(singleBaseline.sources.map((source: { id: string }) => source.id)).toEqual(["single-zero-stint"]);
    expect(singleBaseline.fuel.value).toBe(0);
    expect(singleBaseline.tires.map((rate: { value: number }) => rate.value)).toEqual([0, 0, 0, 0]);
    expect(singleBaseline.fuel.eligibleLaps).toBe(1);
    const missingEnergy = await api.get(`/api/race-plans/generation-evidence?gameId=lmu&carId=lmu-car&trackId=${trackId}&weather=any`);
    expect(missingEnergy.ok(), await missingEnergy.text()).toBe(true);
    expect((await missingEnergy.json()).baseline).toBeNull();
    await runtime.databaseStatement("ALTER TABLE strategy_stints RENAME TO strategy_stints_unavailable", [], true);
    try {
      const unavailable = await api.get(`/api/race-plans/generation-evidence?gameId=${gameId}&carId=${carId}&trackId=${trackId}&weather=dry`);
      expect(unavailable.status()).toBe(503);
      expect(await unavailable.json()).toEqual({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" });
    } finally {
      await runtime.databaseStatement("ALTER TABLE strategy_stints_unavailable RENAME TO strategy_stints", [], true);
    }
    const invalidRequest = await api.get(`/api/race-plans/generation-evidence?gameId=${gameId}&carId=${carId}&trackId=${trackId}&weather=storm`);
    expect(invalidRequest.status()).toBe(400);
    expect(await invalidRequest.json()).toMatchObject({ code: "INVALID_RACE_PLAN" });
  } finally {
    await api.dispose();
    await runtime.stop();
  }
});
