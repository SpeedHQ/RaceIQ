import { createHash } from "node:crypto";
import {
  LMU_MAX_VEHICLES,
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_VEHICLE,
  LMU_SCORING_VEHICLE_SIZE,
  LMU_SCORING_VEHICLES_OFFSET,
} from "./layout";
import { TELEMETRY_CATALOG_HASH, TELEMETRY_CATALOG_VERSION } from "@raceiq/shared/telemetry/catalog/data";
import type { LmuCompetitor } from "@raceiq/shared/telemetry/lmu";
import type { ResolutionState, ResolvedValue, TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";

/** LMU stores orientation rows; the forward vector is the negated third column. */
export function lmuYawFromOrientationMatrix(orientation: readonly number[]): number | null {
  if (orientation.length !== 9 || !orientation.every(Number.isFinite)) return null;
  const x = -orientation[2]!;
  const z = -orientation[8]!;
  return Math.hypot(x, z) > 1e-9 ? Math.atan2(x, z) : null;
}

const PARSER_VERSION = "lmu-scoring-v1";
const LIMITATION = "Scoring-schema support is structurally audited; multiplayer population and cadence require real Windows LMU verification.";
type ChannelValue = string | number | boolean | readonly number[];
type Channel = ResolvedValue<ChannelValue>;
type ScoringIdentity = { driver: string; car: string; vehicleClass: string };
const completedLapsPlusOne = (laps: number) => laps + 1;
const nativeClassPlace = (place: number, otherPlaces: readonly number[]) => place > 0 ? otherPlaces.filter((other) => other > 0 && other < place).length + 1 : null;
const distanceFraction = (distance: number, trackLength: number) => Number.isFinite(trackLength) && trackLength > 0 && Number.isFinite(distance) && distance >= 0 && distance <= trackLength ? distance / trackLength : null;
const byteFraction = (fraction: number) => fraction / 255;
const localVelocityMagnitude = (velocity: readonly number[]) => velocity.every(Number.isFinite) ? Math.hypot(...velocity) : null;
const DERIVATIONS: Record<string, { id: string; version: string; codeHash: string }> = {};
for (const [id, fn] of Object.entries({ completedLapsPlusOne, nativeClassPlace, distanceFraction, byteFraction, localVelocityMagnitude })) {
  DERIVATIONS[`lmu-${id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = { id, version: "1", codeHash: createHash("sha256").update(fn.toString()).digest("hex") };
}

function text(memory: Buffer, offset: number, length: number): string {
  const bytes = memory.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? length : end).toString("utf8").trim();
}
function value(
  semanticId: string,
  channelValue: ChannelValue | null,
  unit: string,
  observedAt: TelemetryTimestamp,
  updateSequence: bigint,
  options: { state?: ResolutionState; mappingStatus?: Channel["mappingStatus"]; derived?: boolean; derivationId?: string; limitations?: readonly string[] } = {},
): Channel {
  const state = options.state ?? (channelValue === null ? "invalid" : "ok");
  const derivation = options.derived ? DERIVATIONS[options.derivationId ?? "lmu-local-velocity-magnitude"] : undefined;
  return {
    semanticId,
    value: state === "ok" ? channelValue : null,
    unit,
    mappingStatus: options.mappingStatus ?? (options.derived ? "derived" : "direct"),
    state,
    confidence: state === "ok" ? 1 : null,
    freshness: "fresh",
    confidenceComponents: { semanticFidelity: options.derived ? 0.9 : 1, freshness: 1, inputCompleteness: 1, ...(options.derived ? { derivationReliability: 0.9 } : {}) },
    provenance: {
      simulator: "lmu",
      parserId: "lmu-scoring",
      parserVersion: PARSER_VERSION,
      sourceChannel: semanticId,
      sourceUnit: unit,
      resolverVersion: PARSER_VERSION,
      catalogVersion: TELEMETRY_CATALOG_VERSION,
      catalogHash: TELEMETRY_CATALOG_HASH,
      ...(derivation ? { derivation } : {}),
      observedAt,
      sourceObservation: { timestamp: observedAt, updateSequence },
    },
    schemaVersion: "1",
    limitations: options.limitations ?? [LIMITATION],
  };
}

/** Tracks stable mID incarnations across scoring-array reorder, departure and replacement. */
export class LmuOpponentIdentityTracker {
  private readonly incarnations = new Map<number, number>();
  private previous = new Map<number, ScoringIdentity>();
  private sessionKey = "";
  private lastScoringElapsed = -1;
  private scoringSequence = 0n;

  reset(): void {
    this.incarnations.clear();
    this.previous.clear();
    this.sessionKey = "";
    this.lastScoringElapsed = -1;
    this.scoringSequence = 0n;
  }

  snapshot(memory: Buffer, sessionKey: string, captureSequence: bigint, playerVehicleId: number | null): readonly LmuCompetitor[] | null {
    if (memory.length < LMU_SCORING_VEHICLES_OFFSET + LMU_MAX_VEHICLES * LMU_SCORING_VEHICLE_SIZE) return null;
    if (this.sessionKey && this.sessionKey !== sessionKey) this.reset();
    this.sessionKey = sessionKey;
    const count = memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    if (count < 0 || count > LMU_MAX_VEHICLES) return null;
    const elapsed = memory.readDoubleLE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
    if (!Number.isFinite(elapsed) || elapsed < 0 || captureSequence < 0n) return null;
    if (elapsed !== this.lastScoringElapsed) {
      this.lastScoringElapsed = elapsed;
      this.scoringSequence++;
    }
    const sourceSequence = this.scoringSequence;
    const observedAt: TelemetryTimestamp = { domain: "session", milliseconds: elapsed * 1000 };
    const current = new Map<number, ScoringIdentity>();
    const rows: { id: number; identity: ScoringIdentity; offset: number; isPlayer: boolean }[] = [];
    let markedPlayer: number | null = null;
    for (let index = 0; index < count; index++) {
      const offset = LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
      const id = memory.readInt32LE(offset + LMU_SCORING_VEHICLE.id);
      if (id < 0 || current.has(id)) return null;
      const identity = {
        driver: text(memory, offset + LMU_SCORING_VEHICLE.driverName, 32),
        car: text(memory, offset + LMU_SCORING_VEHICLE.vehicleName, 64),
        vehicleClass: text(memory, offset + LMU_SCORING_VEHICLE.vehicleClass, 32),
      };
      current.set(id, identity);
      const isPlayer = memory.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer) !== 0;
      if (isPlayer) {
        if (markedPlayer !== null) return null;
        markedPlayer = id;
      }
      rows.push({ id, identity, offset, isPlayer });
    }
    if (markedPlayer !== playerVehicleId) return null;
    for (const { id, identity } of rows) {
      const oldIdentity = this.previous.get(id);
      if (oldIdentity && (oldIdentity.driver !== identity.driver || oldIdentity.car !== identity.car || oldIdentity.vehicleClass !== identity.vehicleClass)) {
        this.incarnations.set(id, (this.incarnations.get(id) ?? 0) + 1);
      } else if (!oldIdentity && this.incarnations.has(id)) {
        this.incarnations.set(id, this.incarnations.get(id)! + 1);
      } else if (!this.incarnations.has(id)) this.incarnations.set(id, 0);
    }
    this.previous = current;
    return rows.map(({ id, identity, offset, isPlayer }) => {
      const channels: Record<string, Channel> = {};
      const addNumber = (key: string, fieldOffset: number, unit: string) => {
        const n = memory.readDoubleLE(offset + fieldOffset);
        channels[key] = value(key, Number.isFinite(n) && n >= 0 ? n : null, unit, observedAt, sourceSequence);
      };
      channels["identity.competitor.driver-name"] = value("identity.competitor.driver-name", identity.driver || null, "text", observedAt, sourceSequence);
      channels["identity.competitor.car-name"] = value("identity.competitor.car-name", identity.car || null, "text", observedAt, sourceSequence);
      channels["identity.competitor.vehicle-class"] = value("identity.competitor.vehicle-class", identity.vehicleClass || null, "text", observedAt, sourceSequence);
      const laps = memory.readInt16LE(offset + LMU_SCORING_VEHICLE.totalLaps);
      channels["race.competitor.total-laps"] = value("race.competitor.total-laps", laps >= 0 ? laps : null, "count", observedAt, sourceSequence);
      channels["race.competitor.current-lap-number"] = value("race.competitor.current-lap-number", laps >= 0 ? completedLapsPlusOne(laps) : null, "count", observedAt, sourceSequence, { derived: true, derivationId: "lmu-completed-laps-plus-one" });
      channels["race.competitor.scoring-time"] = value("race.competitor.scoring-time", elapsed, "s", observedAt, sourceSequence);
      channels["race.competitor.position"] = value("race.competitor.position", memory.readUInt8(offset + LMU_SCORING_VEHICLE.place) || null, "count", observedAt, sourceSequence);
      const nativePlace = memory.readUInt8(offset + LMU_SCORING_VEHICLE.place);
      const otherClassPlaces = identity.vehicleClass ? rows.filter((other) => other.identity.vehicleClass === identity.vehicleClass).map((other) => memory.readUInt8(other.offset + LMU_SCORING_VEHICLE.place)) : [];
      const classPosition = identity.vehicleClass ? nativeClassPlace(nativePlace, otherClassPlaces) : null;
      channels["race.competitor.class-position"] = value("race.competitor.class-position", classPosition, "count", observedAt, sourceSequence, { derived: true, derivationId: "lmu-native-class-place" });
      const sector = memory.readInt8(offset + LMU_SCORING_VEHICLE.sector);
      channels["race.competitor.current-sector"] = value("race.competitor.current-sector", sector >= 0 && sector <= 2 ? sector : null, "index", observedAt, sourceSequence);
      channels["race.competitor.count-lap-flag"] = value("race.competitor.count-lap-flag", memory.readUInt8(offset + LMU_SCORING_VEHICLE.countLapFlag), "index", observedAt, sourceSequence);
      for (const [key, fieldOffset, unit] of [
        ["race.competitor.best-sector-1", LMU_SCORING_VEHICLE.bestSector1, "s"],
        ["race.competitor.best-sector-2-cumulative", LMU_SCORING_VEHICLE.bestSector2, "s"],
        ["race.competitor.last-sector-1", LMU_SCORING_VEHICLE.lastSector1, "s"],
        ["race.competitor.last-sector-2-cumulative", LMU_SCORING_VEHICLE.lastSector2, "s"],
        ["race.competitor.current-sector-1", LMU_SCORING_VEHICLE.currentSector1, "s"],
        ["race.competitor.current-sector-2-cumulative", LMU_SCORING_VEHICLE.currentSector2, "s"],
        ["race.competitor.best-lap-time", LMU_SCORING_VEHICLE.bestLapTime, "s"],
        ["race.competitor.last-lap-time", LMU_SCORING_VEHICLE.lastLapTime, "s"],
        ["race.competitor.lap-start-time", LMU_SCORING_VEHICLE.lapStartElapsedTime, "s"],
        ["race.competitor.lap-distance", LMU_SCORING_VEHICLE.lapDistance, "m"],
        ["race.competitor.time-into-lap-estimate", LMU_SCORING_VEHICLE.timeIntoLap, "s"],
        ["race.competitor.estimated-lap-time", LMU_SCORING_VEHICLE.estimatedLapTime, "s"],
        ["race.competitor.time-behind-next", LMU_SCORING_VEHICLE.timeBehindNext, "s"],
        ["race.competitor.time-behind-leader", LMU_SCORING_VEHICLE.timeBehindLeader, "s"],
      ] as const) addNumber(key, fieldOffset, unit);
      const trackLength = memory.readDoubleLE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
      const lapDistance = memory.readDoubleLE(offset + LMU_SCORING_VEHICLE.lapDistance);
      const fraction = distanceFraction(lapDistance, trackLength);
      channels["race.competitor.lap-fraction"] = value("race.competitor.lap-fraction", fraction, "fraction", observedAt, sourceSequence, { derived: true, derivationId: "lmu-distance-fraction" });
      channels["fuel.competitor.ambiguous-fuel-fraction"] = value("fuel.competitor.ambiguous-fuel-fraction", byteFraction(memory.readUInt8(offset + LMU_SCORING_VEHICLE.fuelFraction)), "fraction", observedAt, sourceSequence, { derived: true, derivationId: "lmu-byte-fraction", limitations: [LIMITATION, "Native scoring field denotes fuel or battery; resource type cannot be identified."] });
      const vector = (key: string, start: number) => [0, 1, 2].forEach((axis) => {
        const axisKey = `${key}.${"xyz"[axis]}`;
        const n = memory.readDoubleLE(offset + start + axis * 8);
        channels[axisKey] = value(axisKey, Number.isFinite(n) ? n : null, key.includes("velocity") ? "m/s" : "m", observedAt, sourceSequence);
      });
      vector("motion.competitor.position", LMU_SCORING_VEHICLE.position);
      vector("motion.competitor.local-velocity", LMU_SCORING_VEHICLE.localVelocity);
      const velocity = [0, 1, 2].map((axis) => memory.readDoubleLE(offset + LMU_SCORING_VEHICLE.localVelocity + axis * 8));
      const speed = localVelocityMagnitude(velocity);
      channels["motion.competitor.speed"] = value("motion.competitor.speed", speed, "m/s", observedAt, sourceSequence, { derived: true, derivationId: "lmu-local-velocity-magnitude" });
      const orientation = Array.from({ length: 9 }, (_, item) => memory.readDoubleLE(offset + LMU_SCORING_VEHICLE.orientation + item * 8));
      channels["motion.competitor.orientation"] = value("motion.competitor.orientation", orientation.every(Number.isFinite) ? orientation : null, "matrix", observedAt, sourceSequence);
      const pitStops = memory.readInt16LE(offset + LMU_SCORING_VEHICLE.pitStopCount);
      channels["race.competitor.pit-stop-count"] = value("race.competitor.pit-stop-count", pitStops >= 0 ? pitStops : null, "count", observedAt, sourceSequence);
      for (const [key, field] of [
        ["race.competitor.laps-behind-next", LMU_SCORING_VEHICLE.lapsBehindNext],
        ["race.competitor.laps-behind-leader", LMU_SCORING_VEHICLE.lapsBehindLeader],
      ] as const) {
        const lapsBehind = memory.readInt32LE(offset + field);
        channels[key] = value(key, lapsBehind >= 0 ? lapsBehind : null, "count", observedAt, sourceSequence);
      }
      const inPits = memory.readUInt8(offset + LMU_SCORING_VEHICLE.inPits);
      channels["race.competitor.in-pits"] = value("race.competitor.in-pits", inPits <= 1 ? inPits === 1 : null, "boolean", observedAt, sourceSequence, {
        limitations: [LIMITATION, "Native mInPits is not always accurate for remote vehicles; this is a source report, not an inferred pit event."],
      });
      const pitState = memory.readUInt8(offset + LMU_SCORING_VEHICLE.pitState);
      channels["race.competitor.pit-state"] = value("race.competitor.pit-state", pitState <= 4 ? pitState : null, "enum", observedAt, sourceSequence);
      const serverScored = memory.readUInt8(offset + LMU_SCORING_VEHICLE.serverScored);
      channels["race.competitor.server-scored"] = value("race.competitor.server-scored", serverScored <= 1 ? serverScored === 1 : null, "boolean", observedAt, sourceSequence, {
        limitations: [LIMITATION, "Server scoring can be disabled in qualifying or racing heats; this is not lap validity."],
      });
      return { vehicleId: id, incarnation: this.incarnations.get(id)!, isPlayer, channels };
    });
  }
}
