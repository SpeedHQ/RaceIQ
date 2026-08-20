import { asc, eq } from "drizzle-orm";

import {
  type AnalysisOutputInventoryEntry,
  type AnalysisProvenanceReceipt,
  type AnalysisVerificationCheck,
} from "../../shared/racing/provenance/contracts";
import { QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import { RACE_EVENT_SCHEMA_VERSION } from "../../shared/racing/events/contracts";
import { SESSION_RUN_SCHEMA_VERSION } from "../../shared/racing/runs/contracts";
import type { DbTransaction } from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import {
  laps,
  raceEvents,
  sessionResults,
  sessionRunEvidence,
  sessionRunLaps,
  sessionRuns,
  sessions,
} from "../db/schema";
import { RACE_RESULT_PROCESSOR_ID } from "../race-results/reconcile";
import { analysisCanonicalHash } from "./current-contract";

export interface SessionAnalysisInventory {
  outputs: AnalysisOutputInventoryEntry[];
  checks: AnalysisVerificationCheck[];
}

function nullableIntegerRange(values: readonly (number | null)[]) {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  return present.length === 0 ? null : { start: Math.min(...present), end: Math.max(...present) };
}

function nullableNumberRange(values: readonly (number | null)[]) {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  return present.length === 0 ? null : { start: Math.min(...present), end: Math.max(...present) };
}

function participants(values: readonly (string | null)[]): string[] | null {
  const result = [...new Set(values.filter((value): value is string => value != null))].sort();
  return result.length === 0 ? null : result;
}

function output(input: Omit<AnalysisOutputInventoryEntry, "timeCoverageMs" | "lapCoverage" | "participantCoverage" | "trackDistanceCoverageM"> & Partial<Pick<AnalysisOutputInventoryEntry, "timeCoverageMs" | "lapCoverage" | "participantCoverage" | "trackDistanceCoverageM">>): AnalysisOutputInventoryEntry {
  return {
    ...input,
    timeCoverageMs: input.timeCoverageMs ?? null,
    lapCoverage: input.lapCoverage ?? null,
    participantCoverage: input.participantCoverage ?? null,
    trackDistanceCoverageM: input.trackDistanceCoverageM ?? null,
  };
}

export async function buildPersistedSessionAnalysisInventory(
  sessionId: number,
  transaction?: DbTransaction,
): Promise<SessionAnalysisInventory> {
  const client = transaction ?? db;
  const [session] = await client.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw new Error("Session not found");
  const [lapRows, eventRows, runRows, membershipRows, evidenceRows, resultRows] = await Promise.all([
    client.select().from(laps).where(eq(laps.sessionId, sessionId)).orderBy(asc(laps.lapNumber), asc(laps.id)),
    client.select().from(raceEvents).where(eq(raceEvents.sessionId, sessionId)).orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    ),
    client.select().from(sessionRuns).where(eq(sessionRuns.sessionId, sessionId)).orderBy(
      asc(sessionRuns.timelineEpoch),
      asc(sessionRuns.openingSequence),
      asc(sessionRuns.openingEventOrder),
      asc(sessionRuns.runId),
    ),
    client.select({ membership: sessionRunLaps, runSessionId: sessionRuns.sessionId })
      .from(sessionRunLaps)
      .innerJoin(sessionRuns, eq(sessionRunLaps.runId, sessionRuns.runId))
      .where(eq(sessionRuns.sessionId, sessionId))
      .orderBy(asc(sessionRunLaps.runId), asc(sessionRunLaps.ordinal), asc(sessionRunLaps.lapEventId)),
    client.select({ evidence: sessionRunEvidence, runSessionId: sessionRuns.sessionId })
      .from(sessionRunEvidence)
      .innerJoin(sessionRuns, eq(sessionRunEvidence.runId, sessionRuns.runId))
      .where(eq(sessionRuns.sessionId, sessionId))
      .orderBy(asc(sessionRunEvidence.runId), asc(sessionRunEvidence.eventId), asc(sessionRunEvidence.role)),
    client.select().from(sessionResults).where(eq(sessionResults.sessionId, sessionId)).limit(1),
  ]);

  const lapSemantic = lapRows.map((lap) => ({
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    isValid: lap.isValid,
    phase: lap.phase,
    conditions: lap.conditions,
    paceEligibility: lap.paceEligibility,
    invalidReason: lap.invalidReason,
    rawByteOffset: lap.rawByteOffset,
    rawFrameCount: lap.rawFrameCount,
    catalogVersion: lap.catalogVersion,
    catalogHash: lap.catalogHash,
    catalogSchemaVersion: lap.catalogSchemaVersion,
    parserVersion: lap.parserVersion,
    resolverVersion: lap.resolverVersion,
    derivationVersion: lap.derivationVersion,
  }));
  const qualitySemantic = {
    recordingQuality: session.recordingQuality,
    laps: lapRows.map((lap) => ({
      lapNumber: lap.lapNumber,
      quality: lap.quality,
      eligibility: lap.eligibility,
      schemaVersion: lap.qualitySchemaVersion,
      policyVersion: lap.qualityPolicyVersion,
      configurationVersion: lap.qualityConfigVersion,
      generation: lap.qualityGeneration,
    })),
  };
  const eventSemantic = eventRows.map((event) => {
    const {
      createdAt: _createdAt,
      contentHash: _contentHash,
      analysisGenerationId: _analysisGenerationId,
      sourceGeneration: _sourceGeneration,
      lapId: _lapId,
      receivedAtMs: _receivedAtMs,
      detectorVersion: _detectorVersion,
      ...semantic
    } = event;
    return semantic;
  });
  const runSemantic = runRows.map((run) => {
    const {
      createdAt: _createdAt,
      contentHash: _contentHash,
      analysisGenerationId: _analysisGenerationId,
      sourceGeneration: _sourceGeneration,
      algorithmVersion: _algorithmVersion,
      runId: _runId,
      startLapId: _startLapId,
      endLapId: _endLapId,
      ...semantic
    } = run;
    return semantic;
  });
  const membershipSemantic = membershipRows.map(({ membership }) => ({
    runId: membership.runId,
    lapEventId: membership.lapEventId,
    lapNumber: membership.lapNumber,
    ordinal: membership.ordinal,
    entryEventId: membership.entryEventId,
    exitEventId: membership.exitEventId,
  }));
  const evidenceSemantic = evidenceRows.map(({ evidence }) => evidence);
  const result = resultRows[0];
  const resultSemantic = result
    ? (() => {
        const {
          id: _id,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          analysisGenerationId: _analysisGenerationId,
          ...semantic
        } = result;
        return semantic;
      })()
    : null;

  const outputs: AnalysisOutputInventoryEntry[] = [
    output({
      name: "laps",
      artifactType: "laps",
      schemaVersion: "lap-analysis-v1",
      count: lapRows.length,
      contentHash: analysisCanonicalHash(lapSemantic),
      lapCoverage: nullableIntegerRange(lapRows.map((lap) => lap.lapNumber)),
    }),
    output({
      name: "race_events",
      artifactType: "race_events",
      schemaVersion: RACE_EVENT_SCHEMA_VERSION,
      count: eventRows.length,
      contentHash: analysisCanonicalHash(eventSemantic),
      timeCoverageMs: nullableIntegerRange(eventRows.flatMap((event) => [event.sourceTimeMs, event.sourceEndTimeMs])),
      lapCoverage: nullableIntegerRange(eventRows.map((event) => event.lapNumber)),
      participantCoverage: participants(eventRows.map((event) => event.participantId)),
      trackDistanceCoverageM: nullableNumberRange(eventRows.map((event) => event.trackDistanceM)),
    }),
    output({
      name: "session_runs",
      artifactType: "session_runs",
      schemaVersion: SESSION_RUN_SCHEMA_VERSION,
      count: runRows.length,
      contentHash: analysisCanonicalHash({ runs: runSemantic, memberships: membershipSemantic, evidence: evidenceSemantic }),
      timeCoverageMs: nullableIntegerRange(runRows.flatMap((run) => [run.startSourceTimeMs, run.endSourceTimeMs])),
      participantCoverage: participants(runRows.map((run) => run.participantId)),
      trackDistanceCoverageM: nullableNumberRange(runRows.flatMap((run) => [run.startTrackDistanceM, run.endTrackDistanceM])),
    }),
    output({
      name: "race_result",
      artifactType: "race_result",
      schemaVersion: result?.processorVersion ?? RACE_RESULT_PROCESSOR_ID,
      count: result ? 1 : 0,
      contentHash: analysisCanonicalHash(resultSemantic),
    }),
    output({
      name: "quality",
      artifactType: "quality",
      schemaVersion: session.qualitySchemaVersion ?? QUALITY_SCHEMA_VERSION,
      count: lapRows.filter((lap) => lap.quality != null).length + (session.recordingQuality ? 1 : 0),
      contentHash: analysisCanonicalHash(qualitySemantic),
      lapCoverage: nullableIntegerRange(lapRows.filter((lap) => lap.quality != null).map((lap) => lap.lapNumber)),
    }),
  ];

  const eventIds = new Set(eventRows.map((event) => event.eventId));
  const lapIds = new Set(lapRows.map((lap) => lap.id));
  const referenceFailures = [
    ...eventRows.filter((event) => event.lapId != null && !lapIds.has(event.lapId)).map((event) => event.eventId),
    ...runRows.filter((run) => !eventIds.has(run.openingEventId) || (run.closingEventId != null && !eventIds.has(run.closingEventId))).map((run) => run.runId),
  ];
  const checks: AnalysisVerificationCheck[] = [
    { id: "session_identity", status: "passed", details: `Session ${sessionId} owns all inventoried rows` },
    { id: "participant_identity", status: "passed", details: "Participant identities preserved as persisted" },
    { id: "ordering", status: "passed", details: "Outputs inventoried in canonical logical order" },
    { id: "coverage", status: referenceFailures.length === 0 ? "passed" : "failed", details: referenceFailures.length === 0 ? "Artifact references resolve" : `${referenceFailures.length} artifact references do not resolve` },
    { id: "storage_state", status: "passed", details: "Persisted artifact rows readable" },
  ];
  return { outputs, checks };
}

export async function auditPersistedSessionAnalysis(receipt: AnalysisProvenanceReceipt): Promise<AnalysisVerificationCheck[]> {
  if (receipt.artifactSetType !== "session_analysis") {
    return [{ id: "storage_state", status: "not_applicable", details: "Receipt does not describe session analysis" }];
  }
  try {
    const inventory = await buildPersistedSessionAnalysisInventory(receipt.sessionId);
    const expected = new Map(receipt.outputs.map((entry) => [entry.name, entry]));
    const mismatches = inventory.outputs.filter((entry) => {
      const declared = expected.get(entry.name);
      return !declared || declared.count !== entry.count || declared.contentHash !== entry.contentHash || analysisCanonicalHash(declared) !== analysisCanonicalHash(entry);
    });
    return [
      ...inventory.checks,
      {
        id: "storage_state",
        status: mismatches.length === 0 ? "passed" : "failed",
        details: mismatches.length === 0 ? "Persisted outputs match active receipt" : `Persisted outputs differ: ${mismatches.map((entry) => entry.name).join(", ")}`,
      },
    ];
  } catch {
    return [{ id: "storage_state", status: "failed", details: "Persisted outputs could not be audited" }];
  }
}
