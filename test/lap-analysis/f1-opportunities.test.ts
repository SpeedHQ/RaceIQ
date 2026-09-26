import { describe, expect, test } from "bun:test";
import { computeLapMetrics } from "../../server/lap-analysis/metrics";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { processLap, restoreF1FrameIndices } from "@shared/racing/analysis/laps/insights/process";
import { detectErsDepletion, detectUnusedDrs } from "@shared/racing/analysis/laps/insights/electronics";
import type { F1ExtendedData } from "@shared/telemetry/f1-2025";
import type { TelemetryPacket } from "@shared/telemetry/types";

initGameAdapters();

function run(kind: "drs" | "ers", hz = 20): TelemetryPacket[] {
  return Array.from({ length: 4 * hz + 1 }, (_, index) => {
    const seconds = index / hz;
    return {
      TimestampMS: seconds * 1_000,
      IsRaceOn: 1,
      LapNumber: 1,
      Speed: 60,
      Accel: 255,
      Brake: 0,
      Clutch: 0,
      HandBrake: 0,
      Gear: 7,
      Steer: 0,
      CurrentEngineRpm: 10_000,
      EngineMaxRpm: 15_000,
      f1: {
        drsAllowed: seconds >= 0.2,
        drsActivated: false,
        drsFault: 0,
        ersFault: 0,
        ersDeployMode: 2,
        ersStoreEnergy: kind === "ers" ? Math.max(0, 100_000 * (1 - seconds)) : 1_000_000 - seconds * 100_000,
        ersDeployedThisLap: 100_000 * Math.min(seconds, 1),
        ersHarvestedThisLap: 0,
        enginePowerMGUK: kind === "ers" && seconds >= 1 ? 1_000 : 120_000,
        fuelRemainingLaps: 10 - seconds * 0.01,
        pitLimiterStatus: 0,
        pitLaneTimerActive: 0,
        safetyCarStatus: 0,
        vehicleFIAFlags: 1,
        surfaceTypeFL: 0,
        surfaceTypeFR: 0,
        surfaceTypeRL: 0,
        surfaceTypeRR: 0,
      } as F1ExtendedData,
    } as TelemetryPacket;
  });
}

describe("F1 DRS opportunity observation", () => {
  test("reports eligible but closed DRS after response grace without guaranteed time loss", () => {
    const telemetry = run("drs");
    const insight = detectUnusedDrs(telemetry);
    expect(insight?.id).toBe("driving-unused-drs");
    expect(insight?.severity).toBe("info");
    expect(insight?.evidenceSource).toBe("native");
    expect(insight?.frameIndices).toHaveLength(1);
    expect(telemetry[insight!.frameIndices[0]].TimestampMS).toBeGreaterThan(700);
    expect(insight?.timeLossS).toBeUndefined();
  });

  test("activation within response grace is not an unused opportunity", () => {
    const telemetry = run("drs");
    for (const packet of telemetry) packet.f1!.drsActivated = packet.TimestampMS >= 500;
    expect(detectUnusedDrs(telemetry)).toBeNull();
  });

  test.each([
    ["fault", { drsFault: 1 }],
    ["unknown fault", { drsFault: undefined }],
    ["pit lane", { pitLaneTimerActive: 1 }],
    ["limiter", { pitLimiterStatus: 1 }],
    ["safety car", { safetyCarStatus: 1 }],
    ["yellow flag", { vehicleFIAFlags: 3 }],
    ["unknown eligibility", { drsAllowed: undefined }],
  ] as const)("suppresses %s evidence", (_name, overrides) => {
    const telemetry = run("drs");
    for (const packet of telemetry) Object.assign(packet.f1!, overrides);
    expect(detectUnusedDrs(telemetry)).toBeNull();
  });

  test("braking and steering reject non-straight full-throttle opportunities", () => {
    const braking = run("drs").map((packet) => ({ ...packet, Brake: 100 }));
    const turning = run("drs").map((packet) => ({ ...packet, Steer: 30 }));
    expect(detectUnusedDrs(braking)).toBeNull();
    expect(detectUnusedDrs(turning)).toBeNull();
  });

  test("a frozen eligible status without sequential updates cannot accumulate an opportunity", () => {
    const telemetry = run("drs");
    const frozen = { ...telemetry[4].f1! };
    for (let index = 4; index < telemetry.length; index++) telemetry[index].f1 = { ...frozen };
    expect(detectUnusedDrs(telemetry)).toBeNull();
    expect(detectUnusedDrs(run("drs").slice(5))).toBeNull();
  });

  test("a telemetry gap cannot be counted as closed DRS time", () => {
    const telemetry = run("drs");
    for (let index = 12; index < telemetry.length; index++) telemetry[index].TimestampMS += 2_000;
    expect(detectUnusedDrs(telemetry)).toBeNull();
  });

  test("known DRS availability survives a shift or initial corner exit", () => {
    const shifted = run("drs").map((packet) => ({ ...packet, Gear: packet.TimestampMS < 500 ? 6 : 7 }));
    const cornerExit = run("drs").map((packet) => ({ ...packet, Steer: packet.TimestampMS < 500 ? 30 : 0 }));
    for (const packets of [shifted, cornerExit]) {
      const insight = detectUnusedDrs(packets);
      expect(insight?.id).toBe("driving-unused-drs");
      expect(packets[insight!.frameIndices[0]].TimestampMS).toBeGreaterThan(1000);
    }
  });

  test("merged same-tick F1 updates retain evidence and original timeline positions", () => {
    for (const kind of ["drs", "ers"] as const) {
      const clean = run(kind);
      // The accumulator emits one snapshot per packet type at the same session time.
      const merged = clean.flatMap((packet) => [{ ...packet, Accel: 0 }, { ...packet }, packet]);
      const id = kind === "drs" ? "driving-unused-drs" : "mech-ers-depletion";
      const expected = analyzeLap(clean, "f1-2025").find((insight) => insight.id === id)!;
      const prepared = processLap(merged, "f1-2025");
      const actualInsights = analyzeLap(prepared.packets, "f1-2025");
      restoreF1FrameIndices(actualInsights, prepared.sourceIndices);
      const actual = actualInsights.find((insight) => insight.id === id);
      expect(computeLapMetrics(1, merged, "f1-2025", null, []).insights).toEqual(actualInsights);
      expect(actual?.severity).toBe("info");
      expect(actual?.frameIndices.map((i) => merged[i].TimestampMS))
        .toEqual(expected.frameIndices.map((i) => clean[i].TimestampMS));
      expect(actual?.frameIndices.every((i) => i % 3 === 2)).toBe(true);
    }
  });
});

describe("F1 ERS depletion observation", () => {
  test.each([20, 50, 100])("detects sustained exhaustion following positive deployment at %i Hz", (hz) => {
    const telemetry = run("ers", hz);
    const insight = detectErsDepletion(telemetry);
    expect(insight?.id).toBe("mech-ers-depletion");
    expect(insight?.severity).toBe("info");
    expect(insight?.frameIndices).toHaveLength(1);
    expect(telemetry[insight!.frameIndices[0]].TimestampMS).toBeGreaterThan(1_000);
    expect(insight?.timeLossS).toBeUndefined();
  });

  test("default zeros and absent power do not establish prior deployment", () => {
    const zero = run("ers");
    for (const packet of zero) Object.assign(packet.f1!, { ersStoreEnergy: 0, ersDeployedThisLap: 0, enginePowerMGUK: 0 });
    expect(detectErsDepletion(zero)).toBeNull();
    const missing = run("ers");
    for (const packet of missing) delete packet.f1!.enginePowerMGUK;
    expect(detectErsDepletion(missing)).toBeNull();
  });

  test.each([
    ["lift", { Accel: 0 }],
    ["shift", { Gear: 8 }],
    ["clutch", { Clutch: 100 }],
    ["braking", { Brake: 100 }],
  ] as const)("does not attribute exhaustion across intentional %s", (_name, overrides) => {
    const telemetry = run("ers");
    for (const packet of telemetry) if (packet.TimestampMS >= 1_000) Object.assign(packet, overrides);
    expect(detectErsDepletion(telemetry)).toBeNull();
  });

  test("a cumulative energy counter reset invalidates the preceding deployment baseline", () => {
    const telemetry = run("ers");
    for (const packet of telemetry) if (packet.TimestampMS >= 1_000) packet.f1!.ersDeployedThisLap = 0;
    expect(detectErsDepletion(telemetry)).toBeNull();
  });

  test.each([
    ["fault", { ersFault: 1 }],
    ["unknown fault", { ersFault: undefined }],
    ["no requested deployment", { ersDeployMode: 0 }],
    ["unknown mode", { ersDeployMode: 99 }],
    ["power without collapse", { enginePowerMGUK: 120_000 }],
  ] as const)("rejects %s rather than diagnosing poor strategy", (_name, overrides) => {
    const telemetry = run("ers");
    for (const packet of telemetry) Object.assign(packet.f1!, overrides);
    expect(detectErsDepletion(telemetry)).toBeNull();
  });

  test("low power without deployment-rate collapse is not exhaustion", () => {
    const telemetry = run("ers");
    for (const packet of telemetry) packet.f1!.ersDeployedThisLap = packet.TimestampMS * 100;
    expect(detectErsDepletion(telemetry)).toBeNull();
  });

  test("frozen status after the store reaches zero supplies no sustained evidence", () => {
    const telemetry = run("ers");
    const frozen = { ...telemetry[20].f1! };
    for (let index = 20; index < telemetry.length; index++) telemetry[index].f1 = { ...frozen };
    expect(detectErsDepletion(telemetry)).toBeNull();
  });

  test("new observations dispatch only for F1", () => {
    expect(analyzeLap(run("drs"), "f1-2025").some((insight) => insight.id === "driving-unused-drs")).toBe(true);
    expect(analyzeLap(run("ers"), "f1-2025").some((insight) => insight.id === "mech-ers-depletion")).toBe(true);
    expect(analyzeLap(run("ers"), "fm-2023").some((insight) => insight.id === "mech-ers-depletion" || insight.id === "driving-unused-drs")).toBe(false);
  });
});
