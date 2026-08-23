import type { OpponentLapFactV1 } from "./opponent-pace-tracker";
import type { F1GridEntry } from "../../shared/telemetry/f1-2025";
import type { IRacingExtendedData } from "../../shared/telemetry/iracing";

export function opponentFactsFromF1Grid(grid: readonly F1GridEntry[], sessionId: string, timelineEpoch: number, sourceSequence: number): OpponentLapFactV1[] {
  return grid.filter((entry) => !entry.isPlayer && (entry.lapValidBitFlags ?? 0) !== 0 && (entry.completedLapNumber ?? 0) > 0 && entry.lastLapTime > 0 && entry.carIndex !== undefined).map((entry) => ({ factId: `f1/${sessionId}/${timelineEpoch}/${entry.carIndex}/${entry.completedLapNumber}`, gameId: "f1-2025", sessionId, timelineEpoch, participantId: String(entry.carIndex), participantName: entry.name, classId: "overall", lapNumber: entry.completedLapNumber!, lapTimeMs: Math.round(entry.lastLapTime * 1000), sectorTimesMs: [entry.lastS1, entry.lastS2, entry.lastS3].map((n) => Math.round(n * 1000)), valid: true, inPit: entry.pitStatus !== 0, completedSessionTimeMs: 0, sourceSequence: entry.completionSourceSequence ?? sourceSequence, sourceQuality: "native-validity" }));
}

export function opponentFactsFromIRacing(data: IRacingExtendedData, sessionId: string, timelineEpoch: number, sourceSequence: number, classByCarIndex: Readonly<Record<number, { id: string; name?: string }>>): OpponentLapFactV1[] {
  const laps = data.carIdxLap, times = data.carIdxLastLapTime, surfaces = data.carIdxTrackSurface;
  if (!laps || !times || !surfaces) return [];
  const facts: OpponentLapFactV1[] = [];
  for (let index = 0; index < Math.min(laps.length, times.length, surfaces.length); index++) {
    const clazz = classByCarIndex[index]; const lap = laps[index]; const time = times[index]; const surface = surfaces[index];
    if (!clazz || index === data.driverCarIdx || !Number.isInteger(lap) || lap <= 0 || !Number.isFinite(time) || time <= 0 || surface < 0 || surface > 3) continue;
    facts.push({ factId: `iracing/${sessionId}/${timelineEpoch}/${index}/${lap}`, gameId: "iracing", sessionId, timelineEpoch, participantId: String(index), participantName: String(index), classId: clazz.id, className: clazz.name, lapNumber: lap, lapTimeMs: Math.round(time * 1000), valid: true, inPit: false, completedSessionTimeMs: 0, sourceSequence, sourceQuality: "conservative-inference" });
  }
  return facts;
}
