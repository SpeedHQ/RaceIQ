import { describe, expect, test } from "bun:test";
import type { TelemetryCatalogData } from "../../../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
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

describe("compiled telemetry resolver derivations", () => {
  test("evaluates and memoizes deterministic derivations", () => {
    let evaluations = 0;
    const derivation: TelemetryDerivation = {
      id: "test.double-speed",
      version: "1",
      output: {
        semanticId: "timing.current-lap",
        unit: "s",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "motion.speed",
          acceptedMappings: ["normalized" as const],
          required: true,
        },
      ],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:test-double-speed",
      evaluate(context) {
        evaluations += 1;
        const speed = context.number("motion.speed");
        return speed === undefined ? context.unavailable() : context.value(speed * 2);
      },
    };
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "timing.current-lap" }],
      derivations: [derivation],
    });
    const slot = resolver.slot("timing.current-lap");
    const frame = resolver.createFrameView(packet("iracing", { Speed: 30 }), 1_000);

    expect(frame.readNumber(slot)).toBe(60);
    expect(frame.readNumber(slot)).toBe(60);
    expect(evaluations).toBe(1);
    expect(frame.resolveNumber(slot).provenance.derivation).toEqual({
      id: derivation.id,
      version: derivation.version,
      codeHash: derivation.codeHash,
    });
  });
  test("rejects cycles before creating a frame", () => {
    const a = {
      id: "cycle-a",
      version: "1",
      output: {
        semanticId: "timing.current-lap",
        unit: "s",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "timing.distance-traveled",
          acceptedMappings: ["derived" as const],
          required: true,
        },
      ],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:cycle-a",
      evaluate: () => ({ state: "missing" as const }),
    };
    const b = {
      id: "cycle-b",
      version: "1",
      output: {
        semanticId: "timing.distance-traveled",
        unit: "m",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "timing.current-lap",
          acceptedMappings: ["derived" as const],
          required: true,
        },
      ],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:cycle-b",
      evaluate: () => ({ state: "missing" as const }),
    };

    expect(() =>
      compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator: "iracing",
        requested: [{ semanticId: "timing.current-lap" }],
        derivations: [a, b],
      }),
    ).toThrow("Telemetry derivation cycle");
  });
  test("propagates stale dependency state through derivations", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "timing.lap-fraction" }],
      staleAfterMs: { "timing.distance-traveled": 50 },
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      packet("f1-2025", {
        TimestampMS: 1_000,
        DistanceTraveled: 2_500,
        f1: { trackLength: 5_000 } as TelemetryPacket["f1"],
      }),
      1_100,
    );

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      state: "stale",
    });
  });
});
