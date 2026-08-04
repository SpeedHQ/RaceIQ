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

describe("compiled telemetry resolver native sources", () => {
  test("reads per-wheel values in declared catalog order", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tires.tire-slip-ratio" }],
    });
    const slot = resolver.slot("tires.tire-slip-ratio");
    const frame = resolver.createFrameView(
      packet("fm-2023", {
        TireSlipRatioFL: 0.1,
        TireSlipRatioFR: 0.2,
        TireSlipRatioRL: 0.3,
        TireSlipRatioRR: 0.4,
      }),
      1_000,
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([
      0.1,
      0.2,
      0.3,
      0.4,
    ]);
    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [0.1, 0.2, 0.3, 0.4],
      state: "ok",
    });
  });
  test("aliases canonical wheel order to iRacing LF/RF/LR keys", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "brakes.brake-line-press" }],
    });
    const slot = resolver.slot("brakes.brake-line-press");
    const frame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: {
          LFbrakeLinePress: 11,
          RFbrakeLinePress: 12,
          LRbrakeLinePress: 13,
          RRbrakeLinePress: 14,
        },
      },
      1_000,
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([11, 12, 13, 14]);
  });
  test("falls back from absent packet fields to native sources", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "motion.speed" }],
    });
    const slot = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      {
        packet: packet("fm-2023", {
          Speed: undefined as unknown as number,
        }),
        nativeValues: { Speed: 61 },
      },
      1_000,
    );

    expect(frame.readNumber(slot)).toBe(61);
  });
  test("does not return raw native units when normalized packet data is absent", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
    });
    const slot = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      {
        packet: packet("acc", {
          Speed: undefined as unknown as number,
        }),
        nativeValues: { "Physics.speedKmh": 219.6 },
      },
      1_000,
    );

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      mappingStatus: "normalized",
      state: "missing",
    });
  });
  test("assembles and reuses ordered native per-wheel storage", () => {
    type NativeFrame = {
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    };
    const resolver = compileTelemetryResolver<NativeFrame>(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tires.tire-slip-ratio" }],
    });
    const slot = resolver.slot("tires.tire-slip-ratio");
    const nativeValues = {
      TireSlipRatioFL: 0.1,
      TireSlipRatioFR: 0.2,
      TireSlipRatioRL: 0.3,
      TireSlipRatioRR: 0.4,
    };
    const nativeFrame: NativeFrame = {
      packet: packet("fm-2023", {
        TireSlipRatioFL: undefined as unknown as number,
        TireSlipRatioFR: undefined as unknown as number,
        TireSlipRatioRL: undefined as unknown as number,
        TireSlipRatioRR: undefined as unknown as number,
      }),
      nativeValues,
    };
    const firstFrame = resolver.createFrameView(nativeFrame, 1_000);
    const first = firstFrame.readValue<number[]>(slot)!;
    expect(first).toEqual([0.1, 0.2, 0.3, 0.4]);

    nativeValues.TireSlipRatioFL = 1.1;
    nativeValues.TireSlipRatioFR = 1.2;
    nativeValues.TireSlipRatioRL = 1.3;
    nativeValues.TireSlipRatioRR = 1.4;
    const secondFrame = resolver.createFrameView(
      nativeFrame,
      1_000,
      firstFrame,
    );
    const second = secondFrame.readValue<number[]>(slot)!;
    expect(second).toBe(first);
    expect(second).toEqual([1.1, 1.2, 1.3, 1.4]);
  });
});
