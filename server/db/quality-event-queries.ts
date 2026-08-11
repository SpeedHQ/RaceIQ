import { eq, inArray, or } from "drizzle-orm";
import type { QualityFact } from "../../shared/racing/quality/contracts";
import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";
import { db } from "./index";
import { compareAnalyses, lapAnalyses, laps, pitEvents, sessionResults, sessions } from "./schema";

interface DurableQualityEvent {
  id: number;
  eventType: string;
  lapNumber: number | null;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
}

export function qualityEventOverlapsFact(event: DurableQualityEvent, lapNumber: number, fact: Pick<QualityFact, "timeRange">): boolean {
  const lapMatches = event.lapNumber === lapNumber;
  if (event.lapNumber != null && !lapMatches) return false;
  if (event.elapsedSeconds != null && fact.timeRange != null) {
    const startMs = event.elapsedSeconds * 1_000;
    const endMs = startMs + Math.max(0, event.durationSeconds ?? 0) * 1_000;
    return startMs <= fact.timeRange.endMs && endMs >= fact.timeRange.startMs;
  }
  return lapMatches;
}

function durableEventId(event: DurableQualityEvent): string {
  return `${event.eventType === "position-change" ? "position-event" : "pit-event"}:${event.id}`;
}

export async function linkSessionQualityEvents(sessionId: number): Promise<number> {
  const session = await db.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sessionId)).get();
  const result = await db.select({ id: sessionResults.id }).from(sessionResults).where(eq(sessionResults.sessionId, sessionId)).get();
  if (!session?.recordingQuality || !result) return 0;

  const events = await db
    .select({
      id: pitEvents.id,
      eventType: pitEvents.eventType,
      lapNumber: pitEvents.lapNumber,
      elapsedSeconds: pitEvents.elapsedSeconds,
      durationSeconds: pitEvents.durationSeconds,
    })
    .from(pitEvents)
    .where(eq(pitEvents.resultId, result.id))
    .all();

  const lapRows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      quality: laps.quality,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .all();
  const changedLapIds: number[] = [];

  for (const lap of lapRows) {
    if (!lap.quality) continue;
    let changed = false;
    const facts = lap.quality.facts.map((fact) => {
      const currentIds = fact.eventIds.filter(
        (eventId) =>
          !eventId.startsWith("pit:") &&
          !eventId.startsWith("position-change:") &&
          !eventId.startsWith("pit-event:") &&
          !eventId.startsWith("position-event:"),
      );
      for (const event of events) {
        if (qualityEventOverlapsFact(event, lap.lapNumber, fact)) currentIds.push(durableEventId(event));
      }
      const eventIds = [...new Set(currentIds)].sort();
      if (eventIds.length !== fact.eventIds.length || eventIds.some((id, index) => id !== fact.eventIds[index])) {
        changed = true;
      }
      return { ...fact, eventIds };
    });
    if (!changed) continue;

    const generated = finalizeLapQualityGeneration({ ...lap.quality, facts }, session.recordingQuality.provenance.sourceGeneration, {
      lapNumber: lap.lapNumber,
      rawByteOffset: lap.rawByteOffset,
      rawFrameCount: lap.rawFrameCount ?? 0,
    });
    await db
      .update(laps)
      .set({
        quality: generated.quality,
        eligibility: generated.eligibility,
        qualityGeneration: generated.quality.provenance.outputGeneration,
        qualityPolicyVersion: generated.quality.provenance.policyVersion,
        qualitySchemaVersion: generated.quality.provenance.schemaVersion,
        qualityConfigVersion: generated.quality.provenance.configurationVersion,
      })
      .where(eq(laps.id, lap.id))
      .run();
    changedLapIds.push(lap.id);
  }

  if (changedLapIds.length > 0) {
    await db.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, changedLapIds)).run();
    await db
      .delete(compareAnalyses)
      .where(or(inArray(compareAnalyses.lapAId, changedLapIds), inArray(compareAnalyses.lapBId, changedLapIds)))
      .run();
  }
  return changedLapIds.length;
}
