import { asc, eq, inArray, or } from "drizzle-orm";
import type { RaceEvent } from "../../shared/racing/events/contracts";
import { RaceEventSchema } from "../../shared/racing/events/contracts";
import type { QualityFact } from "../../shared/racing/quality/contracts";
import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";
import { db } from "./index";
import { compareAnalyses, lapAnalyses, laps, raceEvents, sessions } from "./schema";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LINKED_EVENT_TYPES = new Set<RaceEvent["eventType"]>([
  "pit_entry",
  "pit_stall_arrival",
  "pit_service_started",
  "tire_service_observed",
  "fuel_service_observed",
  "repair_service_observed",
  "driver_service_observed",
  "pit_service_completed",
  "pit_stall_departure",
  "pit_exit",
  "pit_visit_incomplete",
  "drive_through_observed",
  "incident_observed",
  "damage_warning_started",
  "damage_warning_cleared",
  "penalty_issued",
  "penalty_cleared",
  "car_reset",
  "fast_repair_used",
  "retirement_observed",
  "source_connected",
  "source_disconnected",
  "source_stale",
  "source_recovered",
  "telemetry_gap",
  "out_of_order_input",
  "duplicate_input_suppressed",
  "storage_drop",
  "storage_failure",
  "timeline_discontinuity",
]);

export function qualityEventOverlapsFact(event: Pick<RaceEvent, "lapNumber" | "sourceTimeMs" | "sourceEndTimeMs">, lapNumber: number, fact: Pick<QualityFact, "timeRange">): boolean {
  if (event.lapNumber != null && event.lapNumber !== lapNumber) return false;
  if (event.sourceTimeMs != null && event.sourceEndTimeMs != null && fact.timeRange != null) {
    return event.sourceTimeMs <= fact.timeRange.endMs && event.sourceEndTimeMs >= fact.timeRange.startMs;
  }
  return event.lapNumber === lapNumber;
}

function isTimelineEventId(eventId: string): boolean {
  return eventId.startsWith("race-event:sha256:") || eventId.startsWith("pit-event:") || eventId.startsWith("position-event:") || eventId.startsWith("pit:") || eventId.startsWith("position-change:");
}

async function linkSessionQualityEventsInTransaction(tx: DbTransaction, sessionId: number): Promise<number> {
  const [session] = await tx.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!session?.recordingQuality) return 0;

  const eventRows = await tx
    .select()
    .from(raceEvents)
    .where(eq(raceEvents.sessionId, sessionId))
    .orderBy(asc(raceEvents.timelineEpoch), asc(raceEvents.sequence), asc(raceEvents.eventOrder), asc(raceEvents.eventId))
    .all();
  const events = eventRows.map((row) => RaceEventSchema.parse(row)).filter((event) => LINKED_EVENT_TYPES.has(event.eventType));
  const lapRows = await tx
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
      const currentIds = fact.eventIds.filter((eventId) => !isTimelineEventId(eventId));
      for (const event of events) {
        if (qualityEventOverlapsFact(event, lap.lapNumber, fact)) currentIds.push(event.eventId);
      }
      const eventIds = [...new Set(currentIds)].sort();
      if (eventIds.length !== fact.eventIds.length || eventIds.some((eventId, index) => eventId !== fact.eventIds[index])) {
        changed = true;
      }
      return { ...fact, eventIds };
    });
    if (!changed) continue;

    const generated = finalizeLapQualityGeneration({ ...lap.quality, facts }, session.recordingQuality.provenance.sourceGeneration, {
      lapNumber: lap.lapNumber,
      rawByteOffset: lap.rawByteOffset,
      rawFrameCount: lap.rawFrameCount,
    });
    await tx
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
    await tx.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, changedLapIds)).run();
    await tx
      .delete(compareAnalyses)
      .where(or(inArray(compareAnalyses.lapAId, changedLapIds), inArray(compareAnalyses.lapBId, changedLapIds)))
      .run();
  }
  return changedLapIds.length;
}

export function linkSessionQualityEvents(sessionId: number, transaction?: DbTransaction): Promise<number> {
  if (transaction) return linkSessionQualityEventsInTransaction(transaction, sessionId);
  return db.transaction((tx) => linkSessionQualityEventsInTransaction(tx, sessionId));
}
