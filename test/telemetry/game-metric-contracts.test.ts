import { describe, expect, test } from "bun:test";
import {
  assertGameMetricContracts,
  assertSemanticBinding,
  unavailableAnalysisFeatures,
} from "../../shared/games/metric-contracts";
import { KNOWN_GAME_IDS } from "../../shared/games/ids";
import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
describe("semantic metric bindings", () => {
  test("accepts Forza normalized lateral slip", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "lateralSlip",
        { kind: "value", semanticId: "tires.normalized-tire-slip-angle" },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "continuous" },
      ),
    ).not.toThrow();
  });

  test("rejects unavailable Forza physical slip angle", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "slipAngle",
        { kind: "value", semanticId: "tires.tire-slip-angle" },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "continuous" },
      ),
    ).toThrow("fm-2023.slipAngle: tires.tire-slip-angle is unavailable");
  });

  test("rejects unknown semantic ID", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "mystery",
        { kind: "value", semanticId: "not-a-semantic" as never },
        TELEMETRY_CATALOG,
      ),
    ).toThrow("fm-2023.mystery: unknown semantic not-a-semantic");
  });

  test("rejects per-wheel binding of scalar value", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "rpm",
        { kind: "value", semanticId: "engine.current-engine-rpm" },
        TELEMETRY_CATALOG,
        { display: "per-wheel" },
      ),
    ).toThrow("fm-2023.rpm: engine.current-engine-rpm does not match per-wheel display");
  });

  test("rejects freshness mismatch", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "lateralSlip",
        { kind: "value", semanticId: "tires.normalized-tire-slip-angle" },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "pit-snapshot" },
      ),
    ).toThrow("fm-2023.lateralSlip: tires.normalized-tire-slip-angle freshness mismatch");
  });

  test("accepts yaw-only balance inputs for Forza", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "balance",
        {
          kind: "derived",
          derivation: "physical-balance-v1",
          requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y"],
        },
        TELEMETRY_CATALOG,
      ),
    ).not.toThrow();
  });

  test("accepts group and derivation bindings with available inputs", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "tires",
        {
          kind: "group",
          required: ["tires.normalized-tire-slip-angle"],
          optional: [],
        },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "continuous" },
      ),
    ).not.toThrow();

    expect(() =>
      assertSemanticBinding(
        "f1-2025",
        "gForce",
        {
          kind: "derived",
          derivation: "g-force-v1",
          requires: ["motion.acceleration-x"],
        },
        TELEMETRY_CATALOG,
      ),
    ).not.toThrow();
  });
  test("every advertised capability resolves against catalog", () => {
    initGameAdapters();
    expect(() =>
      assertGameMetricContracts(
        KNOWN_GAME_IDS.map((id) => getGame(id)),
        TELEMETRY_CATALOG,
      ),
    ).not.toThrow();
  });

  test("reports disabled features from missing canonical requirements", () => {
    const adapter = getGame("ac-evo");
    const available = new Set([
      "motion.speed",
      "motion.acceleration-x",
      "motion.acceleration-z",
      "motion.angular-velocity-y",
      "inputs.steer",
      "tires.wheel-rotation-speed",
    ]);

    expect(unavailableAnalysisFeatures(adapter, available)).toEqual(expect.arrayContaining([
      { feature: "balance", missingSemanticIds: ["tires.tire-slip-angle"] },
      { feature: "brakeBias", missingSemanticIds: ["brakes.brake-bias"] },
      { feature: "gripDemand", missingSemanticIds: ["tires.tire-slip-angle"] },
      { feature: "slipAngle", missingSemanticIds: ["tires.tire-slip-angle"] },
    ]));
  });
});
