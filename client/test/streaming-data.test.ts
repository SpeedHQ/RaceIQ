import { describe, expect, it } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { buildLiveTelemetryView } from "../src/lib/live-telemetry-view";
import { projectOverlayData } from "../src/lib/streaming-data";
import type { OverlayConfig } from "../src/lib/streaming-config";

const config: OverlayConfig = { widget: "driving", unit: "metric" };
function makeSchema(ids: string[], game: GameId = "acc", units: Record<string, string> = {}): LiveTelemetrySchemaMessageV1 {
  return { type: "telemetry-schema", protocolVersion: 1, schemaId: "schema", simulator: game, catalogVersion: "v", catalogHash: "h", catalogSchemaVersion: "1", parserVersion: "p", resolverVersion: "r", derivationVersion: "d", definitions: ids.map((semanticId) => ({ semanticId, unit: units[semanticId] ?? null, mappingStatus: "direct", schemaVersion: "1", limitations: [] })) };
}
function makeFrame(schema: LiveTelemetrySchemaMessageV1, values: unknown[], context: LiveTelemetryFrameMessageV1["context"] = {}, sequence = 1): LiveTelemetryFrameMessageV1 {
  return { type: "telemetry-frame", protocolVersion: 1, schemaId: schema.schemaId, streamId: "stream", sessionId: 1, sequence, observedAt: { domain: "session", milliseconds: sequence }, receivedAtMs: sequence, values: values as never[], context };
}
function project(schema: LiveTelemetrySchemaMessageV1, frame: LiveTelemetryFrameMessageV1, age = 0, unit: OverlayConfig["unit"] = "metric") {
  return projectOverlayData(schema, frame, buildLiveTelemetryView(schema, frame) ?? null, true, age, { widget: "driving", unit });
}

describe("streaming data", () => {
  it("projects converted driving values and ComboDash gears", () => {
    const schema = makeSchema(["motion.speed", "inputs.gear", "engine.current-engine-rpm", "engine.engine-max-rpm", "inputs.accel", "inputs.brake"], "acc", { "inputs.accel": "0–255", "inputs.brake": "ratio" });
    const frame = makeFrame(schema, [50, 4, 8000, 10000, 127.5, 0]);
    expect(project(schema, frame)).toMatchObject({ speed: 180, speedUnit: "km/h", gear: "3", rpm: 8000, rpmFraction: 0.8, throttlePct: 50, brakePct: 0 });
    expect(project(schema, makeFrame(schema, [50, 0, 0, 10000, 0, 0]))).toMatchObject({ speed: 180, gear: "R", rpm: 0, rpmFraction: 0, throttlePct: 0, brakePct: 0 });
    expect(project(schema, makeFrame(schema, [50, 1, 0, 0, 0, 0]))).toMatchObject({ gear: "N", rpm: 0, rpmFraction: undefined });
    expect(project(schema, frame, 0, "imperial")).toMatchObject({ speed: 112, speedUnit: "mph" });
  });

  it("supports percentage and ratio pedal units and withholds unknown units", () => {
    const percent = makeSchema(["inputs.accel", "inputs.brake"], "acc", { "inputs.accel": "%", "inputs.brake": "ratio" });
    expect(project(percent, makeFrame(percent, [50, 0.5]))).toMatchObject({ throttlePct: 50, brakePct: 50 });
    const unknown = makeSchema(["inputs.accel"], "acc", { "inputs.accel": "raw" });
    expect(project(unknown, makeFrame(unknown, [128])).throttlePct).toBeUndefined();
  });
  it("projects fresh clutch inputs with normalized pedal units and frame identity", () => {
    const ratio = makeSchema(["inputs.clutch"], "acc", { "inputs.clutch": "ratio" });
    const ratioFrame = makeFrame(ratio, [0.5], {}, 7);
    expect(project(ratio, ratioFrame)).toMatchObject({
      clutchPct: 50,
      inputFrame: { streamId: "stream", sessionId: 1, sequence: 7 },
    });

    const percent = makeSchema(["inputs.clutch"], "acc", { "inputs.clutch": "%" });
    expect(project(percent, makeFrame(percent, [125])).clutchPct).toBe(100);
    expect(project(percent, makeFrame(percent, [-25])).clutchPct).toBe(0);

    const bytes = makeSchema(["inputs.clutch"], "acc", { "inputs.clutch": "0-255" });
    expect(project(bytes, makeFrame(bytes, [127.5])).clutchPct).toBe(50);
    const unknown = makeSchema(["inputs.clutch"], "acc", { "inputs.clutch": "raw" });
    expect(project(unknown, makeFrame(unknown, [128])).clutchPct).toBeUndefined();
    expect(project(makeSchema([]), makeFrame(makeSchema([]), [])).clutchPct).toBeUndefined();

    const stale = makeFrame(ratio, [0.5]);
    expect(project(ratio, { ...stale, freshness: { 0: "stale" } } as LiveTelemetryFrameMessageV1).clutchPct).toBeUndefined();
  });


  it("clears values for disconnect, mismatch, and stale frames while accepting the 2000ms boundary", () => {
    const schema = makeSchema(["motion.speed", "race.race-position", "race.competitor.position"], "f1-2025");
    const frame = makeFrame(schema, [50, 2, [1, 2]]);
    const view = buildLiveTelemetryView(schema, frame)!;
    expect(projectOverlayData(schema, frame, view, true, 2000, config)).toMatchObject({ status: "live", speed: 180 });
    const stale = projectOverlayData(schema, frame, view, true, 2001, config);
    expect(stale.status).toBe("stale");
    expect(stale).not.toHaveProperty("speed");
    expect(stale.standings).toEqual([]);
    expect(projectOverlayData(schema, frame, view, false, 0, config)).toMatchObject({ status: "disconnected", standings: [] });
    expect(projectOverlayData({ ...schema, schemaId: "other" }, frame, view, true, 0, config).status).toBe("waiting");
    expect(projectOverlayData(schema, { ...frame, sequence: 2 }, view, true, 0, config).status).toBe("waiting");
    expect(projectOverlayData(schema, { ...frame, streamId: "new-stream" }, view, true, 0, config).status).toBe("waiting");
    expect(projectOverlayData(schema, { ...frame, sessionId: 2 }, view, true, 0, config).status).toBe("waiting");
  });

  it("withholds sparse non-fresh channels independently", () => {
    const schema = makeSchema(["motion.speed", "inputs.gear"]);
    const frame = { ...makeFrame(schema, [50, 3]), states: { 0: "stale" } } as LiveTelemetryFrameMessageV1;
    expect(project(schema, frame)).toMatchObject({ speed: undefined, gear: "2" });
  });

  it("requires a valid sector projection reference for delta, including zero", () => {
    const schema = makeSchema(["inputs.accel"]);
    const invalid = makeFrame(schema, [0], { sectors: { estimatedLap: 0, bestLapTime: 90, deltaToBest: 0 } as never });
    expect(project(schema, invalid).deltaToBestS).toBeUndefined();
    const negative = makeFrame(schema, [0], { sectors: { estimatedLap: 90, bestLapTime: 90, deltaToBest: -0.125 } as never });
    const zero = makeFrame(schema, [0], { sectors: { estimatedLap: 90, bestLapTime: 90, deltaToBest: 0 } as never });
    expect(project(schema, zero).deltaToBestS).toBe(0);
  });

  it("sorts unambiguous F1 standings and selects adjacent rows around player", () => {
    const schema = makeSchema(["race.race-position", "race.competitor.position", "race.competitor.driver-name", "timing.competitor.gap-to-leader"], "f1-2025");
    const values = [4, [7, 1, 4, 2, 6, 3, 5], ["Seven", "One", "Four", "Two", "Six", "Three", "Five"], [6, 0, 3, 1, 5, 2, 4]];
    const data = project(schema, makeFrame(schema, values));
    expect(data.standings.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(data.nearby.map((row) => row.position)).toEqual([2, 3, 4, 5, 6]);
    expect(data.standings.find((row) => row.isPlayer)?.position).toBe(4);
    expect(data.standings[0]).toMatchObject({ sourceIndex: 1, name: "One", gapToLeaderS: 0 });
  });

  it("withholds ambiguous rows and nearby selection without a unique player row", () => {
    const schema = makeSchema(["race.race-position", "race.competitor.position"], "f1-2025");
    const duplicatePlayer = project(schema, makeFrame(schema, [2, [1, 2, 2]]));
    expect(duplicatePlayer.standings.map((row) => row.position)).toEqual([1]);
    expect(duplicatePlayer.nearby).toEqual([]);
    const absentPlayer = project(schema, makeFrame(schema, [8, [1, 2, 3, 4, 5, 6]]));
    expect(absentPlayer.nearby).toEqual([]);
  });

  it("marks other games unsupported rather than fabricating race order", () => {
    const acc = makeSchema([], "acc");
    expect(project(acc, makeFrame(acc, [])).raceDataStatus).toBe("unsupported");
    expect(project(acc, makeFrame(acc, [])).standings).toEqual([]);
  });
  it("projects native damage channels independently and distinguishes unsupported from waiting", () => {
    const accIds = ["front", "rear", "left", "right", "centre"].map((part) => `damage.car-damage-${part}`);
    const acc = makeSchema(accIds, "acc", Object.fromEntries(accIds.map((id) => [id, "%"])));
    const accData = project(acc, makeFrame(acc, [0, 10, 20, 30, 40]));
    expect(accData.damageDataStatus).toBe("available");
    expect(accData.damage.map(({ semanticId, pct }) => [semanticId, pct])).toEqual(accIds.map((id, i) => [id, [0, 10, 20, 30, 40][i]]));
    expect(project(acc, makeFrame(acc, [undefined, undefined, undefined, undefined, undefined])).damageDataStatus).toBe("waiting");
    const f1Ids = ["damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage", "damage.floor-damage", "damage.diffuser-damage", "damage.sidepod-damage"];
    const f1 = makeSchema(f1Ids, "f1-2025", Object.fromEntries(f1Ids.map((id) => [id, "%"])));
    expect(project(f1, makeFrame(f1, [1, 2, 3, 4, 5, 6])).damage.map((row) => row.pct)).toEqual([1, 2, 3, 4, 5, 6]);
    const unsupported = makeSchema(["damage.car-damage-front"], "fm-2023", { "damage.car-damage-front": "%" });
    expect(project(unsupported, makeFrame(unsupported, [8])).damageDataStatus).toBe("unsupported");
    const sparse = makeFrame(acc, [0, 10, 20, 30, 40]);
    sparse.freshness = { 1: "stale" };
    const sparseData = project(acc, sparse);
    expect(sparseData.damage[0]?.pct).toBe(0);
    expect(sparseData.damage[1]?.pct).toBeUndefined();
  });
});
