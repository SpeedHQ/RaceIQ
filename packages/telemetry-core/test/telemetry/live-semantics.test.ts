import { describe, expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "@raceiq/shared/games/ids";
import { getTelemetryVariable } from "@raceiq/shared/telemetry/catalog/query";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { packet } from "../support-resolver";
import { liveSemanticIds } from "@raceiq/telemetry-core/telemetry/live/semantics";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

describe("live telemetry semantics", () => {
  test("uses canonical per-wheel catalog shapes and direct Kunos mappings", () => {
    expect(getTelemetryVariable("damage.brake-pad-wear")).toMatchObject({ canonicalUnit: "mm", shape: "per-wheel", ordering: ["FL", "FR", "RL", "RR"] });
    expect(getTelemetryVariable("tires.tire-radius")).toMatchObject({ canonicalUnit: "m", shape: "per-wheel" });
    expect(getTelemetryVariable("tires.tire-camber")).toMatchObject({ canonicalUnit: "rad", shape: "per-wheel" });
    expect(getTelemetryVariable("damage.brake-pad-wear").games.acc).toMatchObject({ kind: "direct", sources: ["acc.brakePadWear"] });
    expect(getTelemetryVariable("damage.brake-pad-wear").games["ac-evo"]).toMatchObject({ kind: "direct", sources: ["acc.brakePadWear"] });
    expect(getTelemetryVariable("tires.tire-camber").games.acc).toMatchObject({ kind: "direct", sources: ["acc.tireCamber"] });
    expect(getTelemetryVariable("tires.tire-camber").games["ac-evo"]).toMatchObject({ kind: "direct", sources: ["acc.tireCamber"] });
    expect(getTelemetryVariable("tires.tire-radius").games.acc).toMatchObject({ kind: "direct", sources: ["acc.tireRadius"] });
    expect(getTelemetryVariable("tires.tire-radius").games["ac-evo"].kind).toBe("unavailable");
  });

  test("keeps each live semantic slot unique", () => {
    for (const gameId of KNOWN_GAME_IDS) expect(new Set(liveSemanticIds(gameId)).size).toBe(liveSemanticIds(gameId).length);
  });

  test("compiles every allowlisted ID and resolves fixture-backed values", () => {
    for (const gameId of KNOWN_GAME_IDS) {
      const ids = liveSemanticIds(gameId);
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, { simulator: gameId, requested: ids.map((semanticId) => ({ semanticId })) });
      for (const semanticId of ids) expect(() => resolver.slot(semanticId)).not.toThrow();
      const frame = resolver.createFrameView(packet(gameId), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1) });
      expect(frame.resolveNumber(resolver.slot("motion.speed")).state).toBe("ok");
    }
    for (const gameId of ["acc", "ac-evo"] as const) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, { simulator: gameId, requested: ["damage.brake-pad-wear", "tires.tire-radius", "tires.tire-camber"].map((semanticId) => ({ semanticId })) });
      const frame = resolver.createFrameView(packet(gameId, { acc: { brakePadWear: [1, 2, 3, 4], tireRadius: [0.3, 0.3, 0.3, 0.3], tireCamber: [0.1, 0.1, 0.1, 0.1] } as NonNullable<import("@raceiq/shared/telemetry/types").TelemetryPacket["acc"]> }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1) });
      expect(frame.resolveValue(resolver.slot("damage.brake-pad-wear")).state).not.toBe("error");
      expect(frame.resolveValue(resolver.slot("tires.tire-camber")).state).not.toBe("error");
      expect(frame.resolveValue(resolver.slot("tires.tire-radius")).state).not.toBe("error");
    }
  });
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
  test("keeps long-race F1 lap position fresh only when native SESSION observations renew track metadata", () => {
    const projector = new LiveTelemetryProjector();
    const project = (now: number, sessionUpdatedAt: number, trackLength = 3000) => projector.project({
      packet: packet("f1-2025", { TimestampMS: now, DistanceTraveled: 1500,
        f1: { trackLength, safetyCarStatusUpdatedAt: sessionUpdatedAt / 1000 } as TelemetryPacket["f1"] }),
      sessionId: 8, receivedAtMs: now,
    });
    const first = project(0, 0);
    const slot = first.schema!.definitions.findIndex((entry) => entry.semanticId === "timing.lap-fraction");
    expect(first.frame!.values[slot]).toBe(0.5);
    const renewed = project(600_000, 600_000);
    expect(renewed.frame!.values[slot]).toBe(0.5);
    expect(renewed.frame!.freshness?.[slot]).toBeUndefined();
    const expired = project(900_001, 600_000);
    expect(expired.frame!.values[slot]).toBeNull();
    expect(expired.frame!.states?.[slot]).toBe("stale");
    const missing = project(900_002, 900_002, 0);
    expect(missing.frame!.values[slot]).toBeNull();
    expect(missing.frame!.states?.[slot]).toBe("missing");
    expect(project(900_003, 900_003).frame!.values[slot]).toBe(0.5);
  });
});
