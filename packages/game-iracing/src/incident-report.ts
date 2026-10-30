import type { IRacingEvidenceStatus, IRacingIncidentCoverageReason, IRacingIncidentEvent, IRacingIncidentReport } from "@raceiq/shared/racing/sessions/iracing-incidents";

export interface IRacingIncidentLapInput { lapId: number; lapNumber: number; eligibleForCleanStreak: boolean }
export interface IRacingIncidentSample {
  kind: "sample"; lapId: number; rawOffset: number; nativeSessionUid: string; driverCarIdx: number;
  sessionTick: number | null; sessionTimeSec: number | null; incidentPoints: number | null; surface: number | null;
}
export type IRacingIncidentInput = IRacingIncidentSample | { kind: "break"; reason: "capture-gap" | "segment-boundary" | "decode-failure"; lapId?: number };
export type IRacingIncidentEventEvidence = IRacingIncidentEvent & { seekReference: { nativeSessionUid: string; sessionTick: number | null; sessionTimeSec: number } };
export interface IRacingIncidentEvidence extends Omit<IRacingIncidentReport, "sessionId" | "coverage" | "events"> {
  incidentStatus: IRacingEvidenceStatus; surfaceStatus: IRacingEvidenceStatus; reasons: IRacingIncidentCoverageReason[]; events: IRacingIncidentEventEvidence[];
}
interface LapState {
  countSamples: number; countPairs: number; countBroken: boolean; points: number;
  surfaceSamples: number; surfacePairs: number; surfaceBroken: boolean; spans: number; seconds: number;
  incomingLapId: number | null; firstEpoch: number | null; lastEpoch: number | null;
}
const timeValid = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const countValid = (value: number | null): value is number => timeValid(value) && Number.isInteger(value);
const surfaceValid = (value: number | null): value is number => value === 0 || value === 1 || value === 2 || value === 3;
type OffTrackEvent = Extract<IRacingIncidentEventEvidence, { kind: "off-track" }>;

/** Reduce only owned observations, in capture order; breaks never invent missing evidence. */
export async function reduceIRacingIncidents(laps: readonly IRacingIncidentLapInput[], input: Iterable<IRacingIncidentInput> | AsyncIterable<IRacingIncidentInput>): Promise<IRacingIncidentEvidence> {
  const states = new Map<number, LapState>(laps.map(lap => [lap.lapId, { countSamples: 0, countPairs: 0, countBroken: false, points: 0, surfaceSamples: 0, surfacePairs: 0, surfaceBroken: false, spans: 0, seconds: 0, incomingLapId: null, firstEpoch: null, lastEpoch: null }]));
  const lapNumbers = new Map(laps.map(lap => [lap.lapId, lap.lapNumber]));
  const reasons = new Set<IRacingIncidentCoverageReason>();
  const events: IRacingIncidentEventEvidence[] = [];
  let previous: IRacingIncidentSample | null = null;
  let counter: IRacingIncidentSample | null = null;
  let location: IRacingIncidentSample | null = null;
  let span: OffTrackEvent | null = null;
  let epoch = 0;
  let interrupted = false;
  let pendingBreakLapId: number | null = null;
  const closeSpan = (endObserved: boolean) => { if (span) span.endObserved = endObserved; span = null; };
  const breakBoth = (reason: IRacingIncidentCoverageReason, lapId?: number) => {
    reasons.add(reason); epoch++;
    if (lapId === undefined || lapId === previous?.lapId) pendingBreakLapId ??= previous?.lapId ?? null;
    if (lapId !== undefined) { const state = states.get(lapId); if (state) { state.countBroken = true; state.surfaceBroken = true; } }
    closeSpan(false); previous = null; counter = null; location = null;
  };
  for await (const sample of input) {
    if (sample.kind === "break") { breakBoth(sample.reason, sample.lapId); continue; }
    const state = states.get(sample.lapId);
    if (!state) { breakBoth("capture-gap"); continue; }
    if (!timeValid(sample.sessionTimeSec)) { breakBoth("missing-evidence", sample.lapId); continue; }
    if (previous) {
      const insideLap = previous.lapId === sample.lapId ? sample.lapId : undefined;
      if (previous.nativeSessionUid !== sample.nativeSessionUid || previous.driverCarIdx !== sample.driverCarIdx) breakBoth("segment-boundary", insideLap);
      else if (sample.sessionTimeSec < previous.sessionTimeSec!) breakBoth("time-reset", insideLap);
      else if (sample.sessionTimeSec - previous.sessionTimeSec! > 0.1 + 0.001) breakBoth("capture-gap", insideLap);
      else if (sample.sessionTimeSec === previous.sessionTimeSec && sample.incidentPoints === previous.incidentPoints && sample.surface === previous.surface && sample.lapId === previous.lapId) continue;
    }
    if (pendingBreakLapId !== null) {
      interrupted = true;
      if (pendingBreakLapId === sample.lapId) { state.countBroken = true; state.surfaceBroken = true; }
      pendingBreakLapId = null;
    }
    if (previous && previous.lapId !== sample.lapId) closeSpan(false);
    if (countValid(sample.incidentPoints)) {
      state.countSamples++;
      if (state.firstEpoch === null) {
        state.firstEpoch = epoch;
        state.incomingLapId = counter?.lapId ?? null;
      }
      if (counter) {
        if (sample.incidentPoints < counter.incidentPoints!) {
          reasons.add("counter-reset"); state.countBroken = true; epoch++;
        } else {
          state.countPairs++;
          const points = sample.incidentPoints - counter.incidentPoints!;
          state.points += points;
          if (points > 0) events.push({ kind: "incident-points", id: `incident-points:${sample.lapId}:${sample.rawOffset}`, lapId: sample.lapId, lapNumber: lapNumbers.get(sample.lapId)!, sessionTimeSec: sample.sessionTimeSec, previousSessionTimeSec: counter.sessionTimeSec!, points, replay: null, seekReference: { nativeSessionUid: sample.nativeSessionUid, sessionTick: sample.sessionTick, sessionTimeSec: sample.sessionTimeSec } });
        }
      }
      state.lastEpoch = epoch;
      counter = sample;
    } else {
      reasons.add("missing-evidence"); state.countBroken = true; counter = null; epoch++;
    }
    if (surfaceValid(sample.surface)) {
      state.surfaceSamples++;
      const contiguous = location !== null && location.lapId === sample.lapId;
      if (contiguous) state.surfacePairs++;
      if (sample.surface === 0) {
        if (!span) {
          span = { kind: "off-track", id: `off-track:${sample.lapId}:${sample.rawOffset}`, lapId: sample.lapId, lapNumber: lapNumbers.get(sample.lapId)!, sessionTimeSec: sample.sessionTimeSec, endSessionTimeSec: sample.sessionTimeSec, observedSeconds: 0, startObserved: contiguous && location!.surface !== 0, endObserved: false, replay: null, seekReference: { nativeSessionUid: sample.nativeSessionUid, sessionTick: sample.sessionTick, sessionTimeSec: sample.sessionTimeSec } };
          state.spans++; events.push(span);
        } else {
          const elapsed = sample.sessionTimeSec - span.endSessionTimeSec;
          span.endSessionTimeSec = sample.sessionTimeSec; span.observedSeconds += elapsed; state.seconds += elapsed;
        }
      } else closeSpan(contiguous);
      location = sample;
    } else {
      reasons.add("missing-evidence"); state.surfaceBroken = true; closeSpan(false); location = null;
    }
    previous = sample;
  }
  closeSpan(false);
  const summaries = laps.map(lap => {
    const state = states.get(lap.lapId)!;
    return { lapId: lap.lapId, lapNumber: lap.lapNumber,
      incidentStatus: (state.countSamples === 0 ? "unavailable" : state.countSamples >= 2 && state.countPairs > 0 && !state.countBroken ? "available" : "partial") as IRacingEvidenceStatus,
      surfaceStatus: (state.surfaceSamples === 0 ? "unavailable" : state.surfaceSamples >= 2 && state.surfacePairs > 0 && !state.surfaceBroken ? "available" : "partial") as IRacingEvidenceStatus,
      observedIncidentPoints: state.countPairs > 0 ? state.points : null,
      offTrackSpans: state.surfaceSamples > 0 ? state.spans : null,
      observedOffTrackSeconds: state.surfacePairs > 0 ? state.seconds : null };
  });
  const aggregate = (key: "incidentStatus" | "surfaceStatus"): IRacingEvidenceStatus => summaries.every(lap => lap[key] === "unavailable") ? "unavailable" : !interrupted && summaries.every(lap => lap[key] === "available") ? "available" : "partial";
  let longest: number | null = null;
  let streak = 0;
  for (let index = 0; index < laps.length; index++) {
    const lap = laps[index], summary = summaries[index], state = states.get(lap.lapId)!;
    const prior = laps[index - 1];
    const priorState = prior ? states.get(prior.lapId)! : null;
    if (lap.eligibleForCleanStreak && summary.incidentStatus === "available") {
      if (summary.observedIncidentPoints === 0) {
        const joins = prior && lap.lapNumber === prior.lapNumber + 1 && state.incomingLapId === prior.lapId && state.firstEpoch === priorState!.lastEpoch;
        streak = joins ? streak + 1 : 1;
      } else streak = 0;
      longest = Math.max(longest ?? 0, streak);
    } else streak = 0;
  }
  const sum = (key: "observedIncidentPoints" | "offTrackSpans" | "observedOffTrackSeconds") => summaries.some(lap => lap[key] !== null) ? summaries.reduce((total, lap) => total + (lap[key] ?? 0), 0) : null;
  return { incidentStatus: aggregate("incidentStatus"), surfaceStatus: aggregate("surfaceStatus"), reasons: [...reasons], observedIncidentPoints: sum("observedIncidentPoints"), offTrackSpans: sum("offTrackSpans"), observedOffTrackSeconds: sum("observedOffTrackSeconds"), longestCleanLapStreak: longest, laps: summaries, events };
}
