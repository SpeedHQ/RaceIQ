import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { CREWCHIEF_CALLOUT_SEMANTIC_IDS } from "../../shared/telemetry/live/crewchief-callout-contract";
import { liveEngineerPaceRequiredSemanticIds, liveEngineerRequiredSemanticIds } from "../../shared/telemetry/live/semantics";
import type { LiveEngineerSessionReplayV1, LiveEngineerReplayAnnotationV1, LiveEngineerReplayFrameV1, LiveEngineerReplayLapV1, LiveEngineerReplaySourceProfileV1, LiveEngineerCalloutSystemV1, LiveEngineerAvailabilityTransitionV1 } from "../../shared/racing/live/engineer-replay-contracts";
import { LiveTelemetryProjector, type LiveResolvedSemanticFrame } from "../telemetry/live-projector";
import { CREWCHIEF_TRIGGER_CATALOG, CrewChiefTriggerCatalog, evaluateCrewChiefAvailability, gameRequirements, type CrewChiefTriggerDescriptor } from "./crewchief-triggers/catalog";
import { LiveEngineerVoiceEngine } from "./live-engineer-voice-engine";
import { renderOpponentPace } from "./live-engineer-renderer";
import type { LiveEngineerRuntimeCandidate } from "./live-engineer-runtime";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { LiveEngineerCalloutMessageV3, LiveEngineerVoiceLineMessageV3 } from "../../shared/racing/live/engineer-contracts";

import { isLiveEngineerSubsystemSupported } from "../../shared/platform/runtime/release-feature-flags";
export type LiveEngineerReplayScenario = "fuel-warning-escalation" | "critical-fuel-pit-sequence" | "scheduled-pit-sequence" | "f1-opponent-lap-pace";
export interface LiveEngineerSessionReplayInput {
  session: { id: number; gameId?: GameId; carOrdinal?: number; trackOrdinal?: number };
  laps: readonly LapMeta[];
  packets: readonly TelemetryPacket[];
  sourceProfile: LiveEngineerReplaySourceProfileV1;
  scenario?: LiveEngineerReplayScenario;
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
  "identity.player-track-surface", "identity.car-ordinal",
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
const frameValues = (frame: LiveResolvedSemanticFrame): Record<string, number | string | boolean | null | readonly (number | string | boolean | null)[]> => Object.fromEntries(frame.ids.flatMap((id, index) => REPLAY_VALUE_IDS.has(id) ? [[id, scalar(frame.values[index]?.value)]] : []));

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
  const scenarioPlan = input.scenario ? buildReplayScenarioPlan(input.packets) : null;
  const scenarioFuelPerLap = input.scenario ? input.packets.find((packet) => packet.acc?.fuelPerLap && packet.acc.fuelPerLap > 0)?.acc?.fuelPerLap : null;
  const semanticIds = [...new Set([...liveEngineerRequiredSemanticIds(gameId), ...CREWCHIEF_CALLOUT_SEMANTIC_IDS, ...REPLAY_VALUE_IDS])];
  const executionMode = "diagnostic-all-games" as const;
  const projector = new LiveTelemetryProjector({ engineerSemanticIds: semanticIds, allowUnsupportedGame: true, engineerEnabled: true });
  const catalog = new CrewChiefTriggerCatalog({ allowUnsupportedGame: true });
  const annotations: LiveEngineerReplayAnnotationV1[] = [];
  const frames: LiveEngineerReplayFrameV1[] = [];
  const semanticFrames: LiveResolvedSemanticFrame[] = [];
  const messages: Array<{ message: LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3; frame: LiveResolvedSemanticFrame }> = [];
  let lastTimelineMs = 0;
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
  const replayLapBySequence = new Map<number, number>();
  for (const [index, packet] of input.packets.entries()) {
    const scenarioPacket = input.scenario && scenarioPlan && scenarioFuelPerLap
      ? replaceAccScenarioPacket(packet, index, input.scenario, scenarioPlan, scenarioFuelPerLap)
      : packet;
    const capturedTimestamp = input.sourceProfile.sourceClockCaptured && Number.isFinite(scenarioPacket.TimestampMS) ? scenarioPacket.TimestampMS : null;
    const timelineMs = capturedTimestamp !== null ? Math.max(lastTimelineMs, capturedTimestamp) : index * 10;
    lastTimelineMs = timelineMs;
    const projection = projector.project({ packet: scenarioPacket, sessionId: input.session.id, receivedAtMs: timelineMs });
    if (Number.isFinite(packet.LapNumber)) replayLapBySequence.set(projection.semanticFrame.sequence, packet.LapNumber);
    latestFrame = projection.semanticFrame;
    semanticFrames.push(projection.semanticFrame);
    frames.push({ frameIndex: index, sourceSequence: projection.semanticFrame.sequence, rawSourceTimestampMs: capturedTimestamp, rawSourceTimestampDomain: capturedTimestamp === null ? null : "session", timelineMs, triggerContext: {}, values: frameValues(projection.semanticFrame) });
    const batch = catalog.consume(projection.semanticFrame);
    for (const event of batch.events) addAnnotation("trigger", event.eventKey, projection.semanticFrame, { family: event.family, candidateId: event.triggerId, lapNumber: event.eventKey === "lap-completed" && typeof event.payload.lap === "number" ? event.payload.lap : Number.isFinite(packet.LapNumber) ? packet.LapNumber : undefined, payload: event.payload, evidence: event.evidenceSemanticIds, priority: event.severity });
    engine.consume(batch);
    if (pitScenario && index === scenarioPlan?.pitThisLapIndex) addSyntheticPitCallout("pit-this-lap", projection.semanticFrame);
    if (pitScenario && index === scenarioPlan?.pitUrgencyIndex) addSyntheticPitCallout("pit-pit-pit", projection.semanticFrame);
  }
  for (const { message, frame } of messages) {
    const linked = annotations.find((annotation) =>
      ("candidateId" in message && message.candidateId && annotation.candidateId === message.candidateId)
      || annotation.decisionId === message.decisionId);
    const family = linked?.family ?? (message.family === "spotter" ? "live-spotter" : message.family === "race-engineer" ? "Spotter" : message.family);
    const lapNumber = replayLapBySequence.get(frame.sequence);
    if (message.type === "live-engineer-callout") addAnnotation("callout", message.family === "race-engineer" ? "race-engineer" : message.family, frame, { family, candidateId: message.candidateId, decisionId: message.decisionId, priority: message.priority, lapNumber, payload: message.render, renderedText: "text" in message.render ? message.render.text : message.family === "opponent-pace" ? renderOpponentPace(message.render.parameters).text : null });
    else addAnnotation("voice-line", message.family, frame, { family, decisionId: message.decisionId, lapNumber, segmentIds: message.segmentIds });
  }
  const laps: LiveEngineerReplayLapV1[] = input.laps.map((lap) => {
    const matching = frames.filter((frame) => frame.values["timing.lap-number"] === lap.lapNumber);
    return { lapId: lap.id, lapNumber: lap.lapNumber, startFrameIndex: matching[0]?.frameIndex ?? null, endFrameIndex: matching.at(-1)?.frameIndex ?? null, metadata: { ...lap } };
  });
  const buildSystem = (systemId: LiveEngineerCalloutSystemV1["systemId"], descriptor: CrewChiefTriggerDescriptor<any> | null, requiredSemanticIds: readonly string[], productionEligible: boolean, implementationStatus: LiveEngineerCalloutSystemV1["implementationStatus"] = "implemented", staticReason?: string): LiveEngineerCalloutSystemV1 => {
    const transitions: LiveEngineerAvailabilityTransitionV1[] = [];
    let previous: "unavailable" | "baseline" | "ready" | null = null;
    if (implementationStatus === "implemented") semanticFrames.forEach((semanticFrame, frameIndex) => {
      const baseEvaluation = descriptor
        ? evaluateCrewChiefAvailability(descriptor, semanticFrame, gameId)
        : evaluateCrewChiefAvailability({ family: "Spotter", source: CREWCHIEF_TRIGGER_CATALOG[0]!.source, requiredSemanticIds: requiredSemanticIds as never, requiredGroups: [], implementationStatus, createState: () => ({}), trigger: () => null } as CrewChiefTriggerDescriptor<any>, semanticFrame, gameId);
      const evaluation = staticReason ? { ...baseEvaluation, lifecycle: "unavailable" as const, reasonCode: staticReason } : baseEvaluation;
      const lifecycle: LiveEngineerAvailabilityTransitionV1["lifecycle"] = evaluation.lifecycle === "ready"
        ? previous === "ready" || previous === "baseline" ? "ready" : "baseline"
        : "unavailable";
      if (lifecycle !== previous) {
        transitions.push({ frameIndex, lifecycle, reasonCode: evaluation.reasonCode, dependencies: evaluation.dependencies });
        previous = lifecycle;
      }
    });
    if (transitions.length === 0) transitions.push({ frameIndex: 0, lifecycle: "unavailable", reasonCode: staticReason ?? implementationStatus, dependencies: [] });
    return {
      systemId,
      implementationStatus,
      productionEligible,
      diagnosticEligible: true,
      lifecycle: transitions.at(-1)?.lifecycle ?? "unavailable",
      transitions,
      requiredSemanticIds,
      optionalSemanticIds: [],
    };
  };
  const systems: LiveEngineerCalloutSystemV1[] = CREWCHIEF_TRIGGER_CATALOG.map((descriptor) => {
    const requirements = gameRequirements(descriptor, gameId);
    return buildSystem(
      `crewchief:${descriptor.family}`,
      descriptor,
      requirements,
      isLiveEngineerSubsystemSupported(gameId, "crewchief"),
      descriptor.implementationStatus,
    );
  });
  systems.push(
    buildSystem("opponent-pace", null, liveEngineerPaceRequiredSemanticIds(gameId), isLiveEngineerSubsystemSupported(gameId, "opponent-pace"), "implemented", input.sourceProfile.limitations.some((limitation) => limitation.includes("persisted-source-not-captured:broadcast")) ? "persisted-source-not-captured" : undefined),
    buildSystem("live-spotter", null, gameId === "iracing" ? ["identity.car-left-right"] : gameId === "acc" ? ["identity.player-car-index", "session.session-state", "motion.position-x", "motion.position-z", "motion.speed", "motion.yaw", "race.pit-status", "race.competitor.car-index", "race.competitor.connected", "motion.competitor.position-x", "motion.competitor.position-z", "motion.competitor.speed", "race.competitor.pit-status"] : [], isLiveEngineerSubsystemSupported(gameId, "live-spotter"), "implemented", input.sourceProfile.limitations.some((limitation) => limitation.includes("persisted-source-not-captured:broadcast")) ? "persisted-source-not-captured" : undefined),
  );
  return { sessionId: input.session.id, gameId, car: { carOrdinal: input.session.carOrdinal ?? null }, track: { trackOrdinal: input.session.trackOrdinal ?? null }, executionMode, sourceProfile: input.sourceProfile, clockQuality: input.sourceProfile.sourceClockCaptured ? "native-session" : "nominal-100hz", frames, laps, annotations, systems, warnings: input.sourceProfile.limitations, sourceCounts: { packets: input.packets.length, annotations: annotations.length } };
}
