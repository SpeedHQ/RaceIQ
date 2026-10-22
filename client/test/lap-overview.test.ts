import { expect, test } from "bun:test";
import type { SemanticLapTelemetry } from "@/hooks/laps";
import { summarizeLapOverview } from "@/lib/lap-overview";

function replay(values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }>): SemanticLapTelemetry {
  return { lapId: 1, requestedSemanticIds: [], envelopes: values.map((entry, sequence) => ({ sequence, observedAt: { domain: "recording", milliseconds: sequence }, receivedAt: { domain: "recording", milliseconds: sequence }, simulator: "test", values: [entry] })) };
}

test("overview summarizes whole-lap wear, distinct temperature channels, counters, and speed", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "tires.tire-wear", value: [0.1, 0.2, 0.3, 0.4] },
    { semanticId: "tires.tire-wear", value: [0.12, 0.22, 0.28, 0.45] },
    { semanticId: "tire.temperature.surface.inner", value: [80, 81, 82, 83] },
    { semanticId: "tire.temperature.core", value: [90, 91, 92, 93] },
    { semanticId: "brakes.brake-temp", value: [300, 310, 320, 330] },
    { semanticId: "fuel.ers-deployed", value: 10 },
    { semanticId: "fuel.ers-deployed", value: 10 },
    { semanticId: "fuel.ers-deployed", value: 35 },
    { semanticId: "fuel.ers-harvested", value: 12 },
    { semanticId: "motion.speed", value: 50 },
    { semanticId: "motion.speed", value: 72 },
  ]));
  expect(result.wear[0]).toBeCloseTo(0.02);
  expect(result.wear[1]).toBeCloseTo(0.02);
  expect(result.wear[2]).toBeNull();
  expect(result.wear[3]).toBeCloseTo(0.05);
  expect(result.temperatures.find(({ id }) => id === "tire.temperature.surface.inner")).toEqual({ id: "tire.temperature.surface.inner", min: 80, max: 83 });
  expect(result.temperatures.find(({ id }) => id === "tire.temperature.core")).toEqual({ id: "tire.temperature.core", min: 90, max: 93 });
  expect(result.temperatures.find(({ id }) => id === "brakes.brake-temp")).toEqual({ id: "brakes.brake-temp", min: 300, max: 330 });
  expect(result.deployed).toBe(35);
  expect(result.recovered).toBe(12);
  expect(result.topSpeed).toBe(72);
});

test("overview preserves a true zero ERS counter", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "fuel.ers-deployed", value: 2287736 },
    { semanticId: "fuel.ers-deployed", value: 0 },
    { semanticId: "fuel.ers-deployed", value: 0, freshness: "stale" },
  ]));
  expect(result.deployed).toBe(0);
});

test("overview uses final ERS counters after carry, reset, and corrections", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "fuel.ers-deployed", value: 61437 },
    { semanticId: "fuel.ers-harvested", value: 87520 },
    { semanticId: "fuel.ers-deployed", value: 0 },
    { semanticId: "fuel.ers-harvested", value: 0 },
    { semanticId: "fuel.ers-deployed", value: 420000 },
    { semanticId: "fuel.ers-harvested", value: 710000 },
    { semanticId: "fuel.ers-deployed", value: 900000 },
    { semanticId: "fuel.ers-harvested", value: 1500000 },
    { semanticId: "fuel.ers-deployed", value: 899980 },
    { semanticId: "fuel.ers-harvested", value: 1499990 },
    { semanticId: "fuel.ers-deployed", value: 2287736 },
    { semanticId: "fuel.ers-harvested", value: 3943638.75 },
    { semanticId: "fuel.ers-deployed", value: 2287000, freshness: "stale" },
    { semanticId: "fuel.ers-harvested", value: 3943000, freshness: "stale" },
  ]));
  expect(result.deployed).toBe(2287736);
  expect(result.recovered).toBe(3943638.75);
});

test("overview ignores invalid readings and keeps the final counter value", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "tires.tire-wear", value: [0.1, 0.2, 0.3, 0.4] },
    { semanticId: "tires.tire-wear", value: [0.2, 0.1, 0.3, Number.NaN] },
    { semanticId: "tires.tire-wear", value: [0.25, 0.3, 0.35, 0.45], state: "unavailable" },
    { semanticId: "motion.speed", value: Infinity },
    { semanticId: "motion.speed", value: 20, freshness: "stale" },
    { semanticId: "fuel.ers-deployed", value: 100 },
    { semanticId: "fuel.ers-deployed", value: 5 },
    { semanticId: "fuel.ers-deployed", value: 5, freshness: "stale" },
  ]));
  expect(result.wear[0]).toBeCloseTo(0.1);
  expect(result.wear.slice(1)).toEqual([null, 0, null]);
  expect(result.deployed).toBe(5);
  expect(result.topSpeed).toBeNull();
  expect(result.recovered).toBeNull();
  expect(result.temperatures.every(({ min, max }) => min === null && max === null)).toBe(true);
  expect(summarizeLapOverview(undefined)).toEqual({
    wear: [null, null, null, null],
    temperatures: result.temperatures.map(({ id }) => ({ id, min: null, max: null })),
    deployed: null,
    recovered: null,
    topSpeed: null,
    startingFuel: null,
    fuelUsed: null,
  });
});

test("overview reports initial fuel and consumption from valid readings", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "fuel.fuel", value: 50 },
    { semanticId: "fuel.fuel", value: 42.5 },
  ]));
  expect(result.startingFuel).toBe(50);
  expect(result.fuelUsed).toBe(7.5);
});

test("overview preserves zero fuel and requires two valid readings for consumption", () => {
  expect(summarizeLapOverview(replay([
    { semanticId: "fuel.fuel", value: 0 },
    { semanticId: "fuel.fuel", value: 0 },
  ]))).toMatchObject({ startingFuel: 0, fuelUsed: 0 });
  expect(summarizeLapOverview(replay([
    { semanticId: "fuel.fuel", value: 12 },
    { semanticId: "fuel.fuel", value: Number.NaN },
  ]))).toMatchObject({ startingFuel: 12, fuelUsed: null });
});

test("overview ignores invalid, stale, and unavailable fuel readings", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "fuel.fuel", value: 99, state: "unavailable" },
    { semanticId: "fuel.fuel", value: 98, freshness: "stale" },
    { semanticId: "fuel.fuel", value: Number.NaN },
    { semanticId: "fuel.fuel", value: -1 },
    { semanticId: "fuel.fuel", value: 30 },
    { semanticId: "fuel.fuel", value: Infinity },
    { semanticId: "fuel.fuel", value: 25, state: "unavailable" },
    { semanticId: "fuel.fuel", value: 27, freshness: "stale" },
    { semanticId: "fuel.fuel", value: 24 },
  ]));
  expect(result.startingFuel).toBe(30);
  expect(result.fuelUsed).toBe(6);
});

test("overview leaves consumption unknown after refueling, even below starting fuel", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "fuel.fuel", value: 50 },
    { semanticId: "fuel.fuel", value: 35 },
    { semanticId: "fuel.fuel", value: 40 },
    { semanticId: "fuel.fuel", value: 30 },
  ]));
  expect(result.startingFuel).toBe(50);
  expect(result.fuelUsed).toBeNull();
});

test("overview detects replacements even when wear later exceeds the initial reading", () => {
  const result = summarizeLapOverview(replay([
    { semanticId: "tires.tire-wear", value: [0.1, 0.2, 0.3, 0.4] },
    { semanticId: "tires.tire-wear", value: [0, 0.25, 0.35, 0.45] },
    { semanticId: "tires.tire-wear", value: [0.2, 0.3, 0.4, 0.5] },
  ]));
  expect(result.wear[0]).toBeNull();
  expect(result.wear[1]).toBeCloseTo(0.1);
});

test("overview handles dense recordings without argument-count limits", () => {
  const data = replay([]);
  const frame = { sequence: 0, observedAt: { domain: "recording", milliseconds: 0 }, receivedAt: { domain: "recording", milliseconds: 0 }, simulator: "test", values: [
    { semanticId: "tire.temperature.core", value: [80, 90, 100, 110] },
    { semanticId: "motion.speed", value: 70 },
  ] };
  data.envelopes = Array.from({ length: 100_000 }, () => frame);
  const result = summarizeLapOverview(data);
  expect(result.topSpeed).toBe(70);
  expect(result.temperatures.find(({ id }) => id === "tire.temperature.core")).toEqual({ id: "tire.temperature.core", min: 80, max: 110 });
});
