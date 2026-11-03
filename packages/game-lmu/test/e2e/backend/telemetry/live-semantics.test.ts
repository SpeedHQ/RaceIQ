import { expect, test } from "bun:test";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
import { liveSemanticIds } from "@raceiq/telemetry-core/telemetry/live/semantics";
  test("resolves LMU session type for live frames", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "lmu",
      requested: [{ semanticId: "session.session-type" }],
    });
    const frame = resolver.createFrameView(
      packet("lmu", { lmu: { sessionType: "race" } as never }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1) },
    );
    expect(frame.resolveValue(resolver.slot("session.session-type")).value).toBe("race");
  });

  test("resolves LMU string identity through the live allowlist", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "lmu",
      requested: liveSemanticIds("lmu").map((semanticId) => ({ semanticId })),
    });
    const frame = resolver.createFrameView(
      packet("lmu", { carId: "Custom / Car", trackId: "spa_2023/spawec", lmu: { carId: "Custom / Car", trackId: "spa_2023/spawec" } as never }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1) },
    );
    expect(frame.resolveValue(resolver.slot("identity.car-id")).value).toBe("Custom / Car");
    expect(frame.resolveValue(resolver.slot("identity.track-id")).value).toBe("spa_2023/spawec");
  });
