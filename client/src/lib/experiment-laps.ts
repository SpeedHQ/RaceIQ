import type { LapMeta } from "@raceiq/shared/racing/sessions/types";

/** Version membership is stamped by the server, including imports and HEAD checkout. */
export function groupExperimentLaps(laps: readonly LapMeta[], tests: readonly { id: number }[]): Map<number, LapMeta[]> {
  const testIds = new Set(tests.map((test) => test.id));
  const map = new Map<number, LapMeta[]>();
  for (const lap of laps) {
    const match = lap.experimentVersionId;
    if (match == null || !testIds.has(match)) continue;
    const group = map.get(match);
    if (group) group.push(lap);
    else map.set(match, [lap]);
  }
  for (const group of map.values()) group.sort((a, b) => a.sessionId - b.sessionId || a.lapNumber - b.lapNumber);
  return map;
}

/** Persisted metadata owns membership and exclusions; live rows may not carry them. */
export function mergeExperimentLaps(persisted: readonly LapMeta[], live: readonly LapMeta[], experimentId: number): LapMeta[] {
  const persistedById = new Map(persisted.map((lap) => [lap.id, lap]));
  const byId = new Map<number, LapMeta>();
  for (const lap of persisted) {
    if (lap.experimentId === experimentId) byId.set(lap.id, lap);
  }
  for (const lap of live) {
    const stored = persistedById.get(lap.id);
    if (stored) {
      if (stored.experimentId === experimentId) byId.set(lap.id, stored);
    } else if (lap.experimentId == null || lap.experimentId === experimentId) {
      byId.set(lap.id, lap);
    }
  }
  return [...byId.values()];
}
