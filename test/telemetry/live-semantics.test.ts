import { describe, expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "../../shared/games/ids";
import { getTelemetryVariable } from "../../shared/telemetry/catalog/query";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import { packet } from "../support/telemetry/resolver";
import { LIVE_CORE_SEMANTIC_IDS, LIVE_GAME_SEMANTIC_IDS, liveSemanticIds } from "../../shared/telemetry/live/semantics";

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

  test("matches exact ordered allowlists and deduplicates", () => {
    expect(LIVE_CORE_SEMANTIC_IDS).toEqual(["brakes.brake-temp","engine.boost","engine.current-engine-rpm","engine.engine-idle-rpm","engine.engine-max-rpm","engine.power","engine.torque","fuel.fuel","fuel.fuel-capacity","identity.car-class","identity.car-ordinal","identity.car-performance-index","identity.drivetrain-type","identity.track-ordinal","inputs.accel","inputs.brake","inputs.gear","inputs.steer","motion.acceleration-x","motion.acceleration-z","motion.pitch","motion.position-x","motion.position-z","motion.roll","motion.speed","motion.yaw","race.race-position","suspension.norm-suspension-travel","timing.best-lap","timing.current-lap","timing.distance-traveled","timing.lap-number","timing.last-lap","tire.temperature.average","tires.tire-combined-slip","tires.tire-pressure","tires.tire-slip-angle","tires.tire-slip-ratio","tires.tire-wear","tires.wheel-in-puddle-depth","tires.wheel-on-rumble-strip","tires.wheel-rotation-speed","weather.air-temp","weather.track-temp","weather.weather-type"]);
    expect(LIVE_GAME_SEMANTIC_IDS).toMatchObject({ "fm-2023": [], acc: ["damage.brake-pad-wear","race.pit-status","tires.tire-compound-name","tires.tire-radius"], "ac-evo": ["damage.brake-pad-wear","race.pit-status","tires.tire-compound-name","tires.tire-radius"], iracing: ["race.on-pit-road","timing.lap-fraction"] });
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
      const frame = resolver.createFrameView(packet(gameId, { brakePadWear: [1, 2, 3, 4], tireRadius: [0.3, 0.3, 0.3, 0.3], tireCamber: [0.1, 0.1, 0.1, 0.1] }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1) });
      expect(frame.resolveValue(resolver.slot("damage.brake-pad-wear")).state).not.toBe("error");
      expect(frame.resolveValue(resolver.slot("tires.tire-camber")).state).not.toBe("error");
      expect(frame.resolveValue(resolver.slot("tires.tire-radius")).state).not.toBe("error");
    }
  });
});
