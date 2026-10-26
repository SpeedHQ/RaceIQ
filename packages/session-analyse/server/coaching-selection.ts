import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import type { CoachingFamily, ThreeToImproveResponse } from "../contracts/coaching";

const FINDING_FAMILY: Readonly<Record<string, CoachingFamily>> = {
  "driving-brake-drag": "brake-drag",
  "driving-downshift-over-rev": "downshift",
  "driving-early-throttle": "throttle",
  "driving-binary-throttle": "throttle",
  "driving-throttle-micro-lifts": "throttle",
  "driving-steering-sawing": "steering",
  "driving-understeer-scrub": "front-scrub",
};

export interface CoachingLap {
  lapId: number;
  lapNumber: number;
  insights: readonly LapInsight[];
  /** Resolve an original capture frame to normalized recorded lap distance. */
  fractionAtSourceFrame(sourceFrameIndex: number): number | null;
  cornerAtFraction(fraction: number): string | null;
}

interface EvidencePoint {
  lapId: number;
  lapNumber: number;
  sourceFrameIndex: number;
  fraction: number;
  cornerName: string | null;
}

interface Candidate {
  family: CoachingFamily;
  bucket: number;
  points: EvidencePoint[];
  laps: Set<number>;
}

export interface CoachingSelection {
  items: ThreeToImproveResponse["items"];
  unlocatedEvidenceCount: number;
}

/** Deterministic family/bucket aggregation over current-version original-frame insights. */
export function selectCoachingPriorities(laps: readonly CoachingLap[]): CoachingSelection {
  const candidates = new Map<string, Candidate>();
  const seen = new Set<string>();
  let unlocatedEvidenceCount = 0;

  for (const lap of laps) {
    for (const insight of lap.insights) {
      const family = FINDING_FAMILY[insight.id];
      if (!family) continue;
      for (const sourceFrameIndex of insight.frameIndices) {
        const pointKey = `${family}:${lap.lapId}:${sourceFrameIndex}`;
        if (seen.has(pointKey)) continue;
        seen.add(pointKey);
        const fraction = lap.fractionAtSourceFrame(sourceFrameIndex);
        if (!Number.isInteger(sourceFrameIndex) || sourceFrameIndex < 0 || fraction == null || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
          unlocatedEvidenceCount++;
          continue;
        }
        const bucket = fraction === 1 ? 49 : Math.floor(fraction * 50);
        const key = `${family}:${bucket}`;
        let candidate = candidates.get(key);
        if (!candidate) {
          candidate = { family, bucket, points: [], laps: new Set() };
          candidates.set(key, candidate);
        }
        candidate.points.push({ lapId: lap.lapId, lapNumber: lap.lapNumber, sourceFrameIndex, fraction, cornerName: lap.cornerAtFraction(fraction) });
        candidate.laps.add(lap.lapId);
      }
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.laps.size - a.laps.size || b.points.length - a.points.length || (a.family < b.family ? -1 : a.family > b.family ? 1 : 0) || a.bucket - b.bucket);
  const families = new Set<CoachingFamily>();
  const buckets = new Set<number>();
  const items: CoachingSelection["items"] = [];
  for (const candidate of ranked) {
    if (items.length === 3) break;
    if (families.has(candidate.family) || buckets.has(candidate.bucket)) continue;
    candidate.points.sort((a, b) => a.lapNumber - b.lapNumber || a.lapId - b.lapId || a.sourceFrameIndex - b.sourceFrameIndex);
    const representative = candidate.points[0]!;
    families.add(candidate.family);
    buckets.add(candidate.bucket);
    items.push({
      id: `${candidate.family}:${candidate.bucket}`,
      family: candidate.family,
      evidenceLevel: candidate.laps.size > 1 ? "repeated" : "single-lap",
      supportingLapCount: candidate.laps.size,
      evidencePointCount: candidate.points.length,
      location: { fraction: representative.fraction, cornerName: representative.cornerName },
      representative: { lapId: representative.lapId, lapNumber: representative.lapNumber, sourceFrameIndex: representative.sourceFrameIndex },
    });
  }
  return { items, unlocatedEvidenceCount };
}
