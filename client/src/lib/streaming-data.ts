import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { convertSpeed, speedLabel } from "@raceiq/frontend-pure/speed";
import { indexTelemetrySchema, readIndexedValue } from "./live-telemetry-view";
import type { LiveTelemetryView } from "./live-telemetry-view";
import type { OverlayConfig } from "./streaming-config";

export interface OverlayCompetitor {
  sourceIndex: number;
  position: number;
  name?: string;
  gapToLeaderS?: number;
  isPlayer: boolean;
}
export interface OverlayDamageRow { semanticId: string; labelKey: string; pct?: number; }
export interface OverlayData {
  status: "live" | "waiting" | "disconnected" | "stale";
  damage: readonly OverlayDamageRow[];
  damageDataStatus: "available" | "unsupported" | "waiting";
  speed?: number;
  speedUnit: "km/h" | "mph";
  gear?: string;
  rpm?: number;
  rpmFraction?: number;
  throttlePct?: number;
  brakePct?: number;
  clutchPct?: number;
  inputFrame?: { streamId: string; sessionId: number | null; sequence: number };
  lapNumber?: number;
  currentLapS?: number;
  racePosition?: number;
  deltaToBestS?: number;
  standings: readonly OverlayCompetitor[];
  nearby: readonly OverlayCompetitor[];
  raceDataStatus: "available" | "unsupported" | "waiting";
}
const ACC_DAMAGE: readonly Omit<OverlayDamageRow, "pct">[] = ["front", "rear", "left", "right", "centre"].map((part) => ({ semanticId: `damage.car-damage-${part}`, labelKey: `streaming_damage_${part}` }));
const F1_DAMAGE: readonly Omit<OverlayDamageRow, "pct">[] = [
  { semanticId: "damage.front-left-wing-damage", labelKey: "f1live_damage_fl_wing" },
  { semanticId: "damage.front-right-wing-damage", labelKey: "f1live_damage_fr_wing" },
  { semanticId: "damage.rear-wing-damage", labelKey: "f1live_damage_rear_wing" },
  { semanticId: "damage.floor-damage", labelKey: "f1live_damage_floor" },
  { semanticId: "damage.diffuser-damage", labelKey: "f1live_damage_diffuser" },
  { semanticId: "damage.sidepod-damage", labelKey: "f1live_damage_sidepod" },
];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positiveInteger = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value > 0;
const empty = (status: OverlayData["status"], config: OverlayConfig, raceDataStatus: OverlayData["raceDataStatus"] = "waiting"): OverlayData => ({
  status,
  speedUnit: speedLabel(config.unit === "metric" ? "kmh" : "mph") as "km/h" | "mph",
  standings: [], nearby: [], raceDataStatus, damage: [], damageDataStatus: "waiting",
});

export function projectOverlayData(
  schema: LiveTelemetrySchemaMessageV1 | null,
  frame: LiveTelemetryFrameMessageV1 | null,
  view: LiveTelemetryView | null,
  connected: boolean,
  ageMs: number,
  config: OverlayConfig,
): OverlayData {
  if (!connected) return empty("disconnected", config);
  if (!schema || !frame || !view || schema.schemaId !== frame.schemaId || frame.schemaId !== schema.schemaId ||
    view.streamId !== frame.streamId || view.sessionId !== frame.sessionId || view.sequence !== frame.sequence) return empty("waiting", config);
  if (ageMs > 2000) return empty("stale", config);
  const damageSchema = view.simulator === "acc" || view.simulator === "ac-evo"
    ? ACC_DAMAGE
    : view.simulator === "f1-2025" ? F1_DAMAGE : [];
  const indexed = indexTelemetrySchema(schema);
  const damage = damageSchema.map(({ semanticId, labelKey }) => {
    const definition = schema.definitions.find((item) => item.semanticId === semanticId);
    const candidate = readIndexedValue(indexed, frame, semanticId);
    const pct = (definition?.mappingStatus === "direct" || definition?.mappingStatus === "normalized") && definition.unit?.trim() === "%" &&
      finite(candidate) && candidate >= 0 && candidate <= 100 ? candidate : undefined;
    return { semanticId, labelKey, pct };
  });
  const damageDataStatus: OverlayData["damageDataStatus"] = damage.length === 0
    ? "unsupported"
    : damage.some((row) => row.pct !== undefined) ? "available" : "waiting";
  const speedUnit = speedLabel(config.unit === "metric" ? "kmh" : "mph") as "km/h" | "mph";
  const speed = finite(view.motion.speedMps) ? Math.round(convertSpeed(view.motion.speedMps, config.unit === "metric" ? "kmh" : "mph")) : undefined;
  const gearValue = view.inputs.gear;
  const gear = finite(gearValue) ? gearValue === 0 ? "R" : gearValue === 1 ? "N" : gearValue >= 2 ? String(gearValue - 1) : undefined : undefined;
  const rpm = finite(view.engine.rpm) ? view.engine.rpm : undefined;
  const rpmFraction = rpm !== undefined && finite(view.engine.maxRpm) && view.engine.maxRpm > 0 ? Math.max(0, Math.min(1, rpm / view.engine.maxRpm)) : undefined;
  const pedal = (semanticId: string, value: number | undefined): number | undefined => {
    if (!finite(value)) return undefined;
    const definition = schema.definitions.find((item) => item.semanticId === semanticId);
    const unit = definition?.unit?.trim();
    const pct = unit === "0–255" || unit === "0-255" ? value / 255 * 100 : unit === "%" ? value : unit === "ratio" ? value * 100 : undefined;
    return pct === undefined ? undefined : Math.max(0, Math.min(100, pct));
  };
  const racePosition = positiveInteger(view.timing.racePosition) ? view.timing.racePosition : undefined;
  const sectors = frame.context.sectors;
  const deltaToBestS = sectors && finite(sectors.estimatedLap) && sectors.estimatedLap > 0 && finite(sectors.bestLapTime) && sectors.bestLapTime > 0 && finite(sectors.deltaToBest)
    ? sectors.deltaToBest
    : undefined;

  let standings: OverlayCompetitor[] = [];
  let nearby: OverlayCompetitor[] = [];
  let raceDataStatus: OverlayData["raceDataStatus"] = "unsupported";
  if (view.simulator === "f1-2025") {
    const candidates = view.competitors.flatMap((competitor, sourceIndex) => positiveInteger(competitor.position)
      ? [{ sourceIndex, position: competitor.position, name: typeof competitor.name === "string" ? competitor.name : undefined, gapToLeaderS: finite(competitor.gapToLeaderS) ? competitor.gapToLeaderS : undefined, isPlayer: competitor.position === racePosition }]
      : []);
    const counts: Record<number, number> = {};
    for (const row of candidates) counts[row.position] = (counts[row.position] ?? 0) + 1;
    standings = candidates.filter((row) => counts[row.position] === 1).sort((a, b) => a.position - b.position);
    raceDataStatus = standings.length ? "available" : "waiting";
    if (racePosition !== undefined) {
      const playerIndex = standings.findIndex((row) => row.position === racePosition);
      if (playerIndex >= 0) nearby = standings.slice(Math.max(0, playerIndex - 2), playerIndex + 3);
    }
  }
  return {
    inputFrame: { streamId: frame.streamId, sessionId: frame.sessionId, sequence: frame.sequence },
    status: "live", speed, speedUnit, gear, rpm, rpmFraction,
    throttlePct: pedal("inputs.accel", view.inputs.throttle),
    brakePct: pedal("inputs.brake", view.inputs.brake),
    clutchPct: pedal("inputs.clutch", view.inputs.clutch),
    lapNumber: positiveInteger(view.timing.lapNumber) ? view.timing.lapNumber : undefined,
    currentLapS: finite(view.timing.currentLapS) ? view.timing.currentLapS : undefined,
    racePosition, deltaToBestS, standings, nearby, raceDataStatus, damage, damageDataStatus,
  };
}
