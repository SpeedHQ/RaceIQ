import { describe, expect, test } from "bun:test";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { packet } from "../../support/telemetry/resolver";

describe("compiled telemetry resolver derivations", () => {
  test("evaluates and memoizes deterministic derivations", () => {
    let evaluations = 0;
    const derivation: TelemetryDerivation = {
      id: "test.double-speed",
      version: "1",
      output: {
        semanticId: "fuel.remaining-percent",
        unit: "%",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "motion.speed",
          acceptedMappings: ["direct" as const],
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
      requested: [{ semanticId: "fuel.remaining-percent" }],
      derivations: [derivation],
    });
    const slot = resolver.slot("fuel.remaining-percent");
    const frame = resolver.createFrameView(packet("iracing", { Speed: 30 }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

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
        semanticId: "timing.sector.current-lap.s1",
        unit: "s",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "timing.sector.current-lap.s2",
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
        semanticId: "timing.sector.current-lap.s2",
        unit: "s",
        valueType: "number" as const,
      },
      inputs: [
        {
          semanticId: "timing.sector.current-lap.s1",
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
        requested: [{ semanticId: "timing.sector.current-lap.s1" }],
        derivations: [a, b],
      }),
    ).toThrow("Telemetry derivation cycle");
  });
  test("propagates stale source observations through derivations", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "timing.lap-fraction" }],
      staleAfterMs: { "timing.track-length": 50 },
    });
    const slot = resolver.slot("timing.lap-fraction");
    const first = resolver.createFrameView(
      packet("f1-2025", {
        TimestampMS: 1_000,
        DistanceTraveled: 2_500,
        f1: { trackLength: 5_000 } as TelemetryPacket["f1"],
      }),
      {
        timestamp: { domain: "session", milliseconds: 1_000 },
        updateSequence: 1n,
      },
    );
    expect(first.readNumber(slot)).toBe(0.5);

    const second = resolver.createFrameView(
      packet("f1-2025", {
        TimestampMS: 1_100,
        DistanceTraveled: 2_600,
        f1: { trackLength: 5_000 } as TelemetryPacket["f1"],
      }),
      {
        timestamp: { domain: "session", milliseconds: 1_100 },
        updateSequence: 2n,
      },
      first,
    );

    expect(second.readNumber(slot)).toBeUndefined();
    expect(second.resolveNumber(slot)).toMatchObject({
      value: null,
      state: "stale",
      freshness: "stale",
    });
  });
});
