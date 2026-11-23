import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { RACE_ENGINEER_CALLOUT_SEMANTIC_IDS } from "@raceiq/shared/telemetry/live/race-engineer-callout-contract";
import { liveEngineerPaceRequiredSemanticIds, liveEngineerRequiredSemanticIds } from "@raceiq/telemetry-core/telemetry/live/semantics";
import type { LiveEngineerSessionReplayV1, LiveEngineerReplayAnnotationV1, LiveEngineerReplayFrameV1, LiveEngineerReplayLapV1, LiveEngineerReplaySourceProfileV1, LiveEngineerCalloutSystemV1, LiveEngineerAvailabilityTransitionV1 } from "@raceiq/shared/racing/live/engineer-replay-contracts";
import { LiveTelemetryProjector, type LiveResolvedSemanticFrame } from "@raceiq/telemetry-core/telemetry/live-projector";
import { RACE_ENGINEER_TRIGGER_CATALOG, RaceEngineerTriggerCatalog, evaluateRaceEngineerAvailability, gameRequirements, type RaceEngineerTriggerDescriptor } from "./race-engineer-triggers/catalog";
import { LiveEngineerVoiceEngine } from "./live-engineer-voice-engine";
import { renderOpponentPace } from "./live-engineer-renderer";
import type { LiveEngineerRuntimeCandidate } from "./live-engineer-runtime";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { LiveEngineerCalloutMessageV3, LiveEngineerVoiceLineMessageV3 } from "@raceiq/shared/racing/live/engineer-contracts";

import { isLiveEngineerSubsystemSupported } from "@raceiq/shared/platform/runtime/release-feature-flags";
export type LiveEngineerReplayScenario = "fuel-warning-escalation" | "critical-fuel-pit-sequence" | "sufficient-fuel-control" | "scheduled-pit-sequence" | "f1-opponent-lap-pace";
export interface LiveEngineerSessionReplayInput {
  session: { id: number; gameId?: GameId; carId?: string; trackId?: string };
  laps: readonly LapMeta[];
  packets: readonly TelemetryPacket[];
  sourceProfile: LiveEngineerReplaySourceProfileV1;
  scenario?: LiveEngineerReplayScenario;
  compactTimeline?: boolean;
}

const REPLAY_VALUE_IDS = new Set([
  "motion.position-x", "motion.position-z", "motion.yaw", "motion.speed", "motion.acceleration-x", "motion.acceleration-z", "motion.angular-velocity-y",
  "timing.lap-number", "timing.lap-fraction", "timing.current-lap", "timing.distance-traveled", "timing.last-lap",
  "inputs.accel", "inputs.brake", "inputs.steer", "inputs.gear", "inputs.clutch",
  "engine.current-engine-rpm", "engine.boost", "engine.power", "engine.torque",
  "fuel.fuel", "fuel.fuel-capacity", "fuel.remaining-volume", "fuel.fuel-percent",
  "brakes.brake-bias", "brakes.brake-temp",
  "tire.temperature.core", "tire.temperature.surface.representative", "tire.temperature.carcass.middle",
  "tires.tire-wear", "tires.tire-pressure", "tires.tire-slip-ratio", "tires.tire-slip-angle", "tires.normalized-tire-slip-angle", "tires.tire-combined-slip", "tires.wheel-rotation-speed", "tires.wheel-on-rumble-strip", "tires.wheel-in-puddle-depth",
  "suspension.norm-suspension-travel", "suspension.suspension-travel-m",
  "identity.player-track-surface", "identity.car-id", "identity.player-car-index", "identity.player-car-class-id",
  "race.pit-status", "race.on-pit-road",
  "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name", "race.competitor.car-class-id", "race.competitor.car-class-name", "race.competitor.laps-complete", "race.competitor.pit-status", "race.competitor.connected", "race.competitor.position", "race.competitor.pit-stops", "race.competitor.track-location",
  "timing.competitor.last-lap-time", "timing.competitor.last-lap-valid", "timing.competitor.gap-to-ahead", "timing.competitor.gap-to-leader",
  "timing.sector.competitor-last.s1", "timing.sector.competitor-last.s2", "timing.sector.competitor-last.s3",
  "tires.competitor.age", "tires.competitor.compound",
  "damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage",
  "damage.floor-damage", "damage.diffuser-damage", "damage.sidepod-damage",
]);
const scalar = (value: unknown): number | string | boolean | null | readonly (number | string | boolean | null)[] => {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => scalar(item) as number | string | boolean | null);
  return null;
};
const frameEvidence = (frame: LiveResolvedSemanticFrame): Pick<LiveEngineerReplayFrameV1, "values" | "states" | "freshness"> => {
  const values: Record<string, LiveEngineerReplayFrameV1["values"][string]> = {};
  const states: Record<string, LiveEngineerReplayFrameV1["states"][string]> = {};
  const freshness: Record<string, LiveEngineerReplayFrameV1["freshness"][string]> = {};
  frame.ids.forEach((id, index) => {
    if (!REPLAY_VALUE_IDS.has(id)) return;
    const resolved = frame.values[index];
    values[id] = scalar(resolved?.value);
    states[id] = resolved?.state ?? "missing";
    freshness[id] = resolved?.freshness ?? "unknown";
  });
  return { values, states, freshness };
};

const findFrameIndex = (frames: readonly LiveEngineerReplayFrameV1[], sequence: number): number => {
  const exact = frames.findIndex((frame) => frame.sourceSequence === sequence);
  return exact >= 0 ? exact : Math.max(0, frames.length - 1);
};
interface ReplayScenarioPlan {
  warningIndex: number;
  criticalIndex: number;
  pitThisLapIndex: number;
  pitUrgencyIndex: number;
  lastIndex: number;
}
const buildReplayScenarioPlan = (packets: readonly TelemetryPacket[]): ReplayScenarioPlan => {
  const lapNumbers = [...new Set(packets.map((packet) => packet.LapNumber))];
  if (lapNumbers.length < 3) throw new Error("Synthetic scenarios require at least three replayable laps");
  const warningLapStart = packets.findIndex((packet) => packet.LapNumber === lapNumbers.at(-2));
  const finalLapStart = packets.findIndex((packet) => packet.LapNumber === lapNumbers.at(-1));
  const lastIndex = packets.length - 1;
  const warningIndex = warningLapStart + 1;
  const criticalIndex = finalLapStart + 1;
  const pitUrgencyIndex = lastIndex - 1;
  const pitThisLapIndex = Math.max(criticalIndex + 1, finalLapStart + Math.round((lastIndex - finalLapStart) * 0.2));
  if (warningIndex >= finalLapStart || pitThisLapIndex >= pitUrgencyIndex) throw new Error("Synthetic scenarios require three complete replayable laps");
  return { warningIndex, criticalIndex, pitThisLapIndex, pitUrgencyIndex, lastIndex };
};
const replaceAccScenarioPacket = (packet: TelemetryPacket, index: number, scenario: LiveEngineerReplayScenario, plan: ReplayScenarioPlan, fuelPerLap: number): TelemetryPacket => {
  if (!packet.acc) return packet;
  const fuelLaps = scenario === "scheduled-pit-sequence" ? 3 : index >= plan.criticalIndex ? 0.8 : index >= plan.warningIndex ? 1.8 : 3;
  const entersPit = scenario !== "fuel-warning-escalation" && index === plan.lastIndex;
  return { ...packet, Fuel: fuelPerLap * fuelLaps, acc: { ...packet.acc, pitStatus: entersPit ? "pit_lane" : "out" } };
};
const decisionIdFor = (candidate: LiveEngineerRuntimeCandidate): string => `${candidate.candidateId}/${candidate.policyVersion}`;

export function runLiveEngineerSessionReplay(input: LiveEngineerSessionReplayInput): LiveEngineerSessionReplayV1 {
  if (input.packets.length === 0) throw new Error("Session has no replayable packets");
  const gameId = input.sourceProfile.gameId;
  const scenarioPlan = gameId === "acc" && input.scenario && input.scenario !== "f1-opponent-lap-pace" ? buildReplayScenarioPlan(input.packets) : null;
  const scenarioFuelPerLap = scenarioPlan ? input.packets.find((packet) => packet.acc?.fuelPerLap && packet.acc.fuelPerLap > 0)?.acc?.fuelPerLap : null;
  const semanticIds = [...new Set([...liveEngineerRequiredSemanticIds(gameId), ...RACE_ENGINEER_CALLOUT_SEMANTIC_IDS, ...REPLAY_VALUE_IDS])];
  const simulatedFuel = gameId === "fm-2023" && (input.scenario === "critical-fuel-pit-sequence" || input.scenario === "sufficient-fuel-control");
  const startingLitres = input.scenario === "sufficient-fuel-control" ? 12 : 5.5;
  const simulatedPitEntryM = 11_000;
  const consumption = `Synthetic fuel: 2 L per 4 km, starting at ${startingLitres} L. Simulated pit entry at ${simulatedPitEntryM} m of recorded driving distance; not a measured track landmark.`;
  if (simulatedFuel && !semanticIds.includes("fuel.fuel-per-lap")) semanticIds.push("fuel.fuel-per-lap");
  const executionMode = "diagnostic-all-games" as const;
  const projector = new LiveTelemetryProjector({ engineerSemanticIds: semanticIds, allowUnsupportedGame: true, engineerEnabled: true });
  const catalog = new RaceEngineerTriggerCatalog({ allowUnsupportedGame: true });
  const annotations: LiveEngineerReplayAnnotationV1[] = [];
  const frames: LiveEngineerReplayFrameV1[] = [];
  const observers: Array<(frame: LiveResolvedSemanticFrame, index: number, newSession: boolean) => boolean> = [];
  const messages: Array<{ message: LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3; frame: LiveResolvedSemanticFrame }> = [];
  let lastTimelineMs = 0;
  let previousCapturedTimestamp: number | null = null;
  const addAnnotation = (stage: LiveEngineerReplayAnnotationV1["stage"], action: string, frame: LiveResolvedSemanticFrame, details: Partial<LiveEngineerReplayAnnotationV1> = {}) => {
    const index = findFrameIndex(frames, frame.sequence);
    const replayFrame = frames[index];
    const lapValue = frame.ids.indexOf("timing.lap-number");
    const frameLap = lapValue >= 0 && typeof frame.values[lapValue]?.value === "number" ? frame.values[lapValue].value as number : undefined;
    annotations.push({ id: `${stage}/${frame.sequence}/${annotations.filter((item) => item.frameIndex === index && item.stage === stage).length}`, frameIndex: index, timelineMs: replayFrame?.timelineMs ?? lastTimelineMs, lapNumber: details.lapNumber ?? frameLap ?? (typeof replayFrame?.values["timing.lap-number"] === "number" ? replayFrame.values["timing.lap-number"] as number : null), position: null, stage, family: details.family ?? "live-spotter", action, candidateId: details.candidateId ?? null, decisionId: details.decisionId ?? null, priority: details.priority ?? null, reason: details.reason ?? null, payload: details.payload ?? null, evidence: details.evidence ?? [], renderedText: details.renderedText ?? null, segmentIds: details.segmentIds ?? [], ...(details.audioLineId ? { audioLineId: details.audioLineId } : {}) });
  };
  const engine = new LiveEngineerVoiceEngine({
    allowUnsupportedGame: true,
    emit: (message) => messages.push({ message, frame: latestFrame! }),
    onCandidate: (candidate, frame) => addAnnotation("candidate", candidate.actionKey, frame, candidateDetails(candidate)),
    onDecision: (candidate, reason, frame) => addAnnotation("decision", reason, frame, { ...candidateDetails(candidate), decisionId: decisionIdFor(candidate), reason }),
    onSelected: (candidate, frame) => addAnnotation("selected", candidate.actionKey, frame, { ...candidateDetails(candidate), decisionId: decisionIdFor(candidate) }),
    onSpotterEvent: (event, frame) => addAnnotation("spotter", "spotter-event", frame, { family: "live-spotter", payload: event }),
  });
  let latestFrame: LiveResolvedSemanticFrame | null = null;
  const candidateDetails = (candidate: LiveEngineerRuntimeCandidate): Partial<LiveEngineerReplayAnnotationV1> => ({ candidateId: candidate.candidateId, priority: candidate.priority, payload: candidate.renderParameters, evidence: candidate.sourceFactIds, family: "relation" in candidate.renderParameters ? "opponent-pace" : candidate.renderParameters.triggerFamily });
  const pitScenario = input.scenario === "critical-fuel-pit-sequence" || input.scenario === "scheduled-pit-sequence";
  const addSyntheticPitCallout = (action: "pit-this-lap" | "pit-pit-pit", frame: LiveResolvedSemanticFrame) => {
    const details = {
      family: "Fuel" as const,
      priority: action === "pit-pit-pit" ? "critical" : "warning",
      payload: { scenario: input.scenario, sequenceStep: action },
      renderedText: action === "pit-pit-pit" ? "Pit pit pit." : "Pit this lap.",
      audioLineId: action,
    };
    addAnnotation("trigger", action, frame, details);
    addAnnotation("voice-line", action, frame, details);
  };
  const buildSystem = (systemId: LiveEngineerCalloutSystemV1["systemId"], descriptor: RaceEngineerTriggerDescriptor<any> | null, requiredSemanticIds: readonly string[], productionEligible: boolean, implementationStatus: LiveEngineerCalloutSystemV1["implementationStatus"] = "implemented", staticReason?: string): LiveEngineerCalloutSystemV1 => {
    const transitions: LiveEngineerAvailabilityTransitionV1[] = [];
    let previous: "unavailable" | "baseline" | "ready" | null = null;
    if (implementationStatus === "implemented") observers.push((semanticFrame, frameIndex, newSession) => {
      if (newSession) previous = null;
      const baseEvaluation = descriptor
        ? evaluateRaceEngineerAvailability(descriptor, semanticFrame, gameId)
        : evaluateRaceEngineerAvailability({ family: "Spotter", source: RACE_ENGINEER_TRIGGER_CATALOG[0]!.source, requiredSemanticIds: requiredSemanticIds as never, requiredGroups: [], implementationStatus, createState: () => ({}), trigger: () => null } as RaceEngineerTriggerDescriptor<any>, semanticFrame, gameId);
      const opponentSource = frames[frameIndex]?.opponentSource;
      const sourceReason = gameId === "acc" && (systemId === "opponent-pace" || systemId === "live-spotter")
        ? opponentSource && opponentSource.state !== "available" ? opponentSource.reasonCode
          : !opponentSource ? "source-unavailable" : undefined
        : undefined;
      const unavailableReason = staticReason ?? sourceReason;
      const evaluation = unavailableReason ? { ...baseEvaluation, lifecycle: "unavailable" as const, reasonCode: unavailableReason } : baseEvaluation;
      const lifecycle: LiveEngineerAvailabilityTransitionV1["lifecycle"] = evaluation.lifecycle === "ready"
        ? previous === "ready" || previous === "baseline" ? "ready" : "baseline"
        : "unavailable";
      if (lifecycle !== previous) {
        transitions.push({ frameIndex, lifecycle, reasonCode: evaluation.reasonCode, dependencies: evaluation.dependencies });
        previous = lifecycle;
        system.lifecycle = lifecycle;
        return true;
      }
      return false;
    });
    if (implementationStatus !== "implemented") transitions.push({ frameIndex: 0, lifecycle: "unavailable", reasonCode: staticReason ?? implementationStatus, dependencies: [] });
    const system: LiveEngineerCalloutSystemV1 = {
      systemId,
      implementationStatus,
      productionEligible,
      diagnosticEligible: true,
      lifecycle: transitions.at(-1)?.lifecycle ?? "unavailable",
      transitions,
      requiredSemanticIds,
      optionalSemanticIds: [],
    };
    return system;
  };
  const systems: LiveEngineerCalloutSystemV1[] = RACE_ENGINEER_TRIGGER_CATALOG.map((descriptor) => {
    const requirements = gameRequirements(descriptor, gameId);
    return buildSystem(
      `race-engineer:${descriptor.family}`,
      descriptor,
      requirements,
      isLiveEngineerSubsystemSupported(gameId, "race-engineer"),
      descriptor.implementationStatus,
    );
  });
  const persistedOpponentReason = (gameId === "acc" && input.sourceProfile.opponentSourceCapture?.status === "unavailable") || gameId === "ac-evo" ? "persisted-source-not-captured" : undefined;
  systems.push(
    buildSystem("opponent-pace", null, liveEngineerPaceRequiredSemanticIds(gameId), isLiveEngineerSubsystemSupported(gameId, "opponent-pace"), "implemented", persistedOpponentReason),
    buildSystem("live-spotter", null, gameId === "iracing" ? ["identity.car-left-right"] : gameId === "acc" ? ["identity.player-car-index", "session.session-state", "motion.position-x", "motion.position-z", "motion.speed", "motion.yaw", "race.pit-status", "race.competitor.car-index", "race.competitor.connected", "motion.competitor.position-x", "motion.competitor.position-z", "motion.competitor.speed", "race.competitor.pit-status"] : [], isLiveEngineerSubsystemSupported(gameId, "live-spotter"), "implemented", persistedOpponentReason),
  );
  const replayLapBySequence = new Map<number, number>();
  const compactTimeline = input.compactTimeline ?? input.scenario === "f1-opponent-lap-pace";
  const snapshotInterval = compactTimeline ? Math.max(1, Math.ceil(input.packets.length / 2_000)) : 1;
  let nativeSession = input.session.id;
  for (const [index, packet] of input.packets.entries()) {
    const scenarioPacket = input.scenario && scenarioPlan && scenarioFuelPerLap
      ? replaceAccScenarioPacket(packet, index, input.scenario, scenarioPlan, scenarioFuelPerLap)
      : packet;
    const capturedTimestamp = input.sourceProfile.sourceClockCaptured && Number.isFinite(scenarioPacket.TimestampMS) ? scenarioPacket.TimestampMS : null;
    const timelineMs = index === 0 ? 0 : lastTimelineMs + (capturedTimestamp !== null && previousCapturedTimestamp !== null ? Math.max(0, capturedTimestamp - previousCapturedTimestamp) : 10);
    previousCapturedTimestamp = capturedTimestamp;
    lastTimelineMs = timelineMs;
    const projectionPacket = capturedTimestamp === null ? { ...scenarioPacket, TimestampMS: timelineMs } : scenarioPacket;
    const prior = input.packets[index - 1];
    const newSession = compactTimeline && !!prior && packet.sessionUID !== prior.sessionUID;
    if (newSession) nativeSession++;
    const projection = projector.project({ packet: projectionPacket, sessionId: nativeSession, receivedAtMs: timelineMs });
    const semanticFrame = { ...projection.semanticFrame, sequence: index, values: [...projection.semanticFrame.values] };
    if (simulatedFuel) {
      const distance = packet.DistanceTraveled;
      for (const id of ["fuel.remaining-volume", "fuel.fuel-per-lap"] as const) {
        const slot = semanticFrame.ids.indexOf(id);
        const value = semanticFrame.values[slot];
        if (!value || !Number.isFinite(distance)) continue;
        semanticFrame.values[slot] = { ...value, state: "ok", freshness: "fresh",
          value: id === "fuel.fuel-per-lap" ? 2 : Math.max(0, startingLitres - Math.max(0, distance) / 2_000),
          limitations: [consumption] };
      }
    }
    latestFrame = semanticFrame;
    const frameIndex = frames.length;
    const record: LiveEngineerReplayFrameV1 = { frameIndex, sourceSequence: index, rawSourceTimestampMs: capturedTimestamp, rawSourceTimestampDomain: capturedTimestamp === null ? null : gameId === "acc" ? "wall-clock" : "session", timelineMs, triggerContext: {}, values: {}, states: {}, freshness: {}, opponentSource: projection.frame?.context.opponentSource ?? null };
    frames.push(record);
    let retain = index % snapshotInterval === 0 || index === input.packets.length - 1 || newSession || packet.LapNumber !== prior?.LapNumber;
    for (const observe of observers) if (observe(semanticFrame, frameIndex, newSession)) retain = true;
    const annotationCount = annotations.length;
    const messageCount = messages.length;
    const batch = catalog.consume(semanticFrame, simulatedFuel ? simulatedPitEntryM - packet.DistanceTraveled : undefined);
    for (const event of batch.events) addAnnotation("trigger", event.eventKey, semanticFrame, { family: event.family, candidateId: event.triggerId, lapNumber: event.eventKey === "lap-completed" && typeof event.payload.lap === "number" ? event.payload.lap : Number.isFinite(packet.LapNumber) ? packet.LapNumber : undefined, payload: event.payload, evidence: event.evidenceSemanticIds, priority: event.severity });
    engine.consume(batch);
    if (pitScenario && index === scenarioPlan?.pitThisLapIndex) addSyntheticPitCallout("pit-this-lap", projection.semanticFrame);
    if (pitScenario && index === scenarioPlan?.pitUrgencyIndex) addSyntheticPitCallout("pit-pit-pit", projection.semanticFrame);
    if (retain || annotations.length !== annotationCount || messages.length !== messageCount) {
      Object.assign(record, frameEvidence(semanticFrame));
      if (Number.isFinite(packet.LapNumber)) replayLapBySequence.set(index, packet.LapNumber);
    } else frames.pop();
  }
  for (const { message, frame } of messages) {
    const linked = annotations.find((annotation) =>
      ("candidateId" in message && message.candidateId && annotation.candidateId === message.candidateId)
      || annotation.decisionId === message.decisionId);
    const family = linked?.family ?? (message.family === "spotter" ? "live-spotter" : message.family === "race-engineer" ? "Spotter" : message.family);
    const lapNumber = replayLapBySequence.get(frame.sequence);
    if (message.type === "live-engineer-callout") addAnnotation("callout", message.family === "race-engineer" ? "race-engineer" : message.family, frame, { family, candidateId: message.candidateId, decisionId: message.decisionId, priority: message.priority, lapNumber, payload: message.render, renderedText: "text" in message.render ? message.render.text : message.family === "opponent-pace" ? renderOpponentPace(message.render.parameters).text : null });
    else addAnnotation("voice-line", message.family, frame, { family, decisionId: message.decisionId, lapNumber, segmentIds: message.segmentIds });
    if (message.type === "live-engineer-callout" && message.family === "race-engineer" && (message.render.textKey === "pit-this-lap" || message.render.textKey === "pit-pit-pit")) {
      addAnnotation("voice-line", message.family, frame, { family, decisionId: message.decisionId, candidateId: message.candidateId, lapNumber, audioLineId: message.render.textKey });
    }
  }
  const laps: LiveEngineerReplayLapV1[] = input.laps.map((lap) => {
    const matching = frames.filter((frame) => frame.values["timing.lap-number"] === lap.lapNumber);
    return { lapId: lap.id, lapNumber: lap.lapNumber, startFrameIndex: matching[0]?.frameIndex ?? null, endFrameIndex: matching.at(-1)?.frameIndex ?? null, metadata: { ...lap } };
  });
  return { sessionId: input.session.id, gameId, car: { carId: input.session.carId ?? null }, track: { trackId: input.session.trackId ?? null }, executionMode, sourceProfile: input.sourceProfile, clockQuality: input.sourceProfile.sourceClockCaptured ? gameId === "acc" ? "captured" : "native-session" : "nominal-100hz", frames, laps, annotations, systems, warnings: simulatedFuel ? [...input.sourceProfile.limitations, consumption] : input.sourceProfile.limitations, sourceCounts: { packets: input.packets.length, annotations: annotations.length } };
}
