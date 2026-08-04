import { describe, expect, test } from "bun:test";
import type { TelemetryCatalogData } from "../../../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { getTelemetryVariable } from "../../../shared/telemetry/catalog/query";
import { TELEMETRY_DERIVATION_VERSION } from "../../../shared/telemetry/derivations/builtins";
import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";
import {
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "../../../shared/telemetry/resolver/versions";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { packet } from "../../support/telemetry/resolver";

describe("compiled telemetry resolver", () => {
  test("compiles normalized packet fields for every supported simulator", () => {
    for (const gameId of KNOWN_GAME_IDS) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator: gameId,
        requested: [{ semanticId: "motion.speed", required: true }],
      });
      const speed = resolver.slot("motion.speed");
      const frame = resolver.createFrameView(packet(gameId), 1_000);

      expect(frame.readNumber(speed)).toBe(42);
      expect(frame.resolveNumber(speed)).toMatchObject({
        semanticId: "motion.speed",
        value: 42,
        mappingStatus: getTelemetryVariable("motion.speed").games[gameId].kind,
        state: "ok",
        provenance: {
          simulator: gameId,
          parserVersion: TELEMETRY_PARSER_VERSIONS[gameId],
          resolverVersion: TELEMETRY_RESOLVER_VERSION,
        },
      });
      expect(resolver.derivationVersion).toBe(TELEMETRY_DERIVATION_VERSION);
    }
  });

  test("uses normalized packet values without running a derivation DAG", () => {
    let evaluations = 0;
    const derivation = {
      id: "test.override-normalized-speed",
      version: "1",
      output: {
        semanticId: "motion.speed",
        unit: "m/s",
        valueType: "number" as const,
      },
      inputs: [],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:test-override-normalized-speed",
      evaluate: () => {
        evaluations += 1;
        return { state: "ok" as const, value: 999 };
      },
    };
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
      derivations: [derivation],
    });
    const resolved = resolver
      .createFrameView(packet("acc", { Speed: 42 }), 1_000)
      .resolveNumber(resolver.slot("motion.speed"));

    expect(resolved).toMatchObject({
      value: 42,
      mappingStatus: "normalized",
      confidence: 0.99,
      confidenceComponents: {
        semanticFidelity: 0.99,
        freshness: 1,
        inputCompleteness: 1,
      },
    });
    expect(resolved.provenance.derivation).toBeUndefined();
    expect(evaluations).toBe(0);
  });

  test("executes normalized fuel-percentage conversions", () => {
    for (const simulator of ["fm-2023", "f1-2025"] as const) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator,
        requested: [{ semanticId: "fuel.fuel-percent" }],
      });
      const slot = resolver.slot("fuel.fuel-percent");
      const frame = resolver.createFrameView(
        packet(simulator, { Fuel: 0.375 }),
        1_000,
      );

      expect(frame.readNumber(slot)).toBe(37.5);
      expect(frame.resolveNumber(slot)).toMatchObject({
        value: 37.5,
        mappingStatus: "normalized",
        state: "ok",
      });
    }
  });

  test("resolves simplified per-wheel values without losing fidelity status", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.average" }],
    });
    const slot = resolver.slot("tire.temperature.carcass.average");
    const frame = resolver.createFrameView(
      packet("iracing", {
        TireCarcassTempFL: 80,
        TireCarcassTempFR: 81,
        TireCarcassTempRL: 82,
        TireCarcassTempRR: 83,
      }),
      1_000,
    );

    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [80, 81, 82, 83],
      mappingStatus: "simplified",
      state: "ok",
    });
  });

  test("reuses one frame view without retaining per-frame values", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
    });
    const speed = resolver.slot("motion.speed");
    const first = resolver.createFrameView(packet("acc", { Speed: 10 }), 1_000);
    expect(first.readNumber(speed)).toBe(10);

    const second = resolver.createFrameView(
      packet("acc", { Speed: 20, TimestampMS: 2_000 }),
      2_000,
      first,
    );
    expect(second).toBe(first);
    expect(second.readNumber(speed)).toBe(20);
  });

  test("separates stale runtime state from mapping fidelity", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
      staleAfterMs: { "motion.speed": 50 },
    });
    const speed = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      packet("acc", { TimestampMS: 1_000 }),
      1_100,
    );

    expect(frame.readNumber(speed)).toBeUndefined();
    expect(frame.resolveNumber(speed)).toMatchObject({
      value: 42,
      mappingStatus: getTelemetryVariable("motion.speed").games.acc.kind,
      state: "stale",
      confidenceComponents: { freshness: 0 },
    });
  });

  test("exposes unavailable mappings through stable slots", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "weather.wind-speed" }],
    });
    const slot = resolver.slot("weather.wind-speed");
    const frame = resolver.createFrameView(packet("f1-2025"), 1_000);

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      mappingStatus: "unavailable",
      state: "missing",
    });
  });


















});
