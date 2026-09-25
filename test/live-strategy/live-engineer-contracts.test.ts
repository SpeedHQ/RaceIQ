import { describe, expect, test } from "bun:test";
import { isLiveEngineerCalloutMessageV3, isOpponentPaceRenderParametersV1 } from "../../shared/racing/live/engineer-contracts";

describe("Live Engineer v3 contracts", () => {
  const parameters = { relation: "within-class-pace" as const, scope: "class" as const, playerLapNumber: 2, playerLapTimeMs: 60_120, benchmarkLapTimeMs: 60_000, deltaMs: 120, benchmarkKind: "session-best" as const };
  test("rejects invalid time arithmetic and protocol versions", () => {
    expect(isOpponentPaceRenderParametersV1(parameters)).toBe(true);
    expect(isOpponentPaceRenderParametersV1({ ...parameters, deltaMs: 121 })).toBe(false);
    expect(isLiveEngineerCalloutMessageV3({ type: "live-engineer-callout", protocolVersion: 1 })).toBe(false);
  });
});
