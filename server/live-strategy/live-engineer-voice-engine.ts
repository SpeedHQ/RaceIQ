import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import type { LiveResolvedSemanticFrame } from "../telemetry/live-projector";
import type { CrewChiefTriggerBatchV1, CrewChiefTriggerEventV1 } from "./crewchief-triggers/contracts";
import { extractLiveEngineerSemanticInput, type LiveEngineerPaceInput } from "./live-engineer-semantic-input";
import {
  createLiveEngineerVoiceLine as createVoiceLine,
  type LiveEngineerCalloutMessageV3,
  type LiveEngineerDeliveryStatusV3,
  type LiveEngineerVoiceLineMessageV3,
  type LiveEngineerVoiceRequestV3,
  type OpponentPaceCalloutMessageV3,
  type SpotterCalloutMessageV3,
  type RaceEngineerCalloutMessageV3,
} from "../../shared/racing/live/engineer-contracts";
import { OpponentPaceTracker, type OpponentLapFactV1, type PlayerLapForPaceV1 } from "./opponent-pace-tracker";
import { LiveEngineerRuntime, type LiveEngineerRuntimeCandidate } from "./live-engineer-runtime";
import { renderOpponentPace, renderSpotter, renderCrewChiefEvent } from "./live-engineer-renderer";
import { SpotterTracker } from "./spotter-tracker";

export type LiveEngineerVoiceLineOptions =
  | { mode: "automatic" }
  | { mode: "exact-response"; requestId: string };

export interface LiveEngineerVoiceEngineOptions {
  emit: (message: LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3) => void;
  allowUnsupportedGame?: boolean;
  onCandidate?: (candidate: LiveEngineerRuntimeCandidate, frame: LiveResolvedSemanticFrame) => void;
  onDecision?: (candidate: LiveEngineerRuntimeCandidate, reason: string, frame: LiveResolvedSemanticFrame) => void;
  onSelected?: (candidate: LiveEngineerRuntimeCandidate, frame: LiveResolvedSemanticFrame) => void;
  onSpotterEvent?: (event: unknown, frame: LiveResolvedSemanticFrame) => void;
}


const OPTIONAL_CONTEXT = ["race.safety-car-status", "race.flag-status", "session.session-flags"] as const;
const NON_ACTIONABLE_AUTOMATIC_EVENTS = new Set(["position-changed", "opponent-lap-completed"]);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finitePositive = (value: unknown): value is number => finite(value) && value > 0;
const isPitStatus = (value: unknown): boolean => typeof value === "string" ? ["in_pit", "pit_lane", "pit", "pit-stall"].includes(value.toLowerCase()) : value === true;
const isCautionStatus = (semanticId: string, value: unknown): boolean => {
  if (semanticId === "race.safety-car-status") return finite(value) ? value !== 0 : value === true;
  if (semanticId === "session.session-flags") return finite(value) ? (value & ((1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9))) !== 0 : false;
  return typeof value === "string" ? ["yellow", "red", "caution"].includes(value.toLowerCase()) : value === true;
};
const observedMs = (timestamp: LiveResolvedSemanticFrame["observedAt"]): number => "milliseconds" in timestamp ? timestamp.milliseconds : Number(timestamp.nanoseconds / 1_000_000n);

export function createLiveEngineerVoiceLine(
  callout: LiveEngineerCalloutMessageV3,
  segmentIds: readonly string[],
  options: LiveEngineerVoiceLineOptions,
): LiveEngineerVoiceLineMessageV3 {
  return createVoiceLine(callout, segmentIds, options);
}

export class LiveEngineerVoiceEngine {
  readonly triggerDiagnostics: CrewChiefTriggerEventV1[] = [];
  private readonly options: LiveEngineerVoiceEngineOptions;
  private readonly emitMessage: LiveEngineerVoiceEngineOptions["emit"];
  private readonly tracker = new OpponentPaceTracker();
  private readonly spotter = new SpotterTracker();
  private readonly accSpotterCars = new Set<number>();
  private readonly runtime = new LiveEngineerRuntime({
    maxQueue: 3,
    now: () => this.runtimeClockMs,
    revalidate: (candidate) => candidate.actionKey !== "opponent-pace-status" ||
      (this.paceAvailable && candidate.sourceSequence > this.lastPaceLossSequence && this.currentContextEligible()),
  });
  private runtimeClockMs = 0;
  private readonly decisions = new Map<string, OpponentPaceCalloutMessageV3>();
  private readonly diagnostics = new Map<string, LiveEngineerDeliveryStatusV3["status"]>();
  private readonly triggerEvents = new Map<string, CrewChiefTriggerEventV1>();
  private latest: LiveResolvedSemanticFrame | null = null;
  private slots = new Map<string, number>();
  private streamKey = "";
  private timelineEpoch = 0;
  private armed = false;
  private previousPlayerLap = 0;
  private playerLapInvalid = false;
  private readonly previousCompetitorLaps = new Map<string, number>();
  private paceAvailable = false;
  private lastPaceLossSequence = -1;
  private pendingLapVoice: { callout: RaceEngineerCalloutMessageV3; segmentIds: readonly string[]; lapNumber: number } | null = null;
  constructor(options: LiveEngineerVoiceEngineOptions) {
    this.options = options;
    this.emitMessage = options.emit;
  }

  consume(input: LiveResolvedSemanticFrame | CrewChiefTriggerBatchV1): void {
    const batch = "events" in input ? input as CrewChiefTriggerBatchV1 : undefined;
    const frame = batch ? batch.semanticFrame : input as LiveResolvedSemanticFrame;
    if (!frame) return;
    const key = `${frame.simulator}/${frame.sessionId ?? "none"}/${frame.streamId}`;
    const targetEpoch = batch?.timelineEpoch ?? (key === this.streamKey ? this.timelineEpoch : this.timelineEpoch + 1);
    if (key !== this.streamKey || targetEpoch !== this.timelineEpoch) {
      this.reset();
      this.streamKey = key;
      this.timelineEpoch = targetEpoch;
      this.tracker.reset(this.timelineEpoch);
      this.runtime.reset(String(frame.sessionId ?? ""), this.timelineEpoch);
    }
    if (batch) {
      this.triggerDiagnostics.push(...batch.events);
      if (this.triggerDiagnostics.length > 64) this.triggerDiagnostics.splice(0, this.triggerDiagnostics.length - 64);
    }
    this.runtimeClockMs = observedMs(frame.observedAt);
    const semanticInput = extractLiveEngineerSemanticInput(frame);
    const values = semanticInput.values;
    if (!this.slots.size) this.slots = new Map(frame.ids.map((id, index) => [id, index]));
    this.latest = frame;
    this.paceAvailable = semanticInput.pace !== null;
    if (!this.paceAvailable) {
      this.tracker.reset(this.timelineEpoch);
      this.previousCompetitorLaps.clear();
      this.decisions.clear();
      this.lastPaceLossSequence = frame.sequence;
    }
    const batchSelection = !!batch;
    if (batch) {
      for (const event of batch.events) {
        if (NON_ACTIONABLE_AUTOMATIC_EVENTS.has(event.eventKey)) continue;
        const candidate: LiveEngineerRuntimeCandidate = {
          candidateId: event.triggerId, actionKey: event.eventKey, cooldownGroup: `race-engineer:${event.family}:${event.eventKey}`, sourceFactIds: [...event.evidenceSemanticIds], policyVersion: "race-engineer-v3",
          renderParameters: { triggerFamily: event.family, eventKey: event.eventKey, payload: event.payload, source: event.source },
          sessionId: event.sessionId, timelineEpoch: event.timelineEpoch, sourceSequence: event.sourceSequence, priority: event.severity === "critical" ? "high" : event.severity === "warning" ? "normal" : "low", createdSessionTimeMs: event.sessionTimeMs, expiresSessionTimeMs: event.sessionTimeMs + 12_000,
        };
        const submission = this.runtime.submit(candidate);
        this.options.onCandidate?.(candidate, frame);
        this.options.onDecision?.(candidate, submission.reason, frame);
        if (submission.reason === "selected") {
          this.triggerEvents.set(event.triggerId, event);
          while (this.triggerEvents.size > 64) this.triggerEvents.delete(this.triggerEvents.keys().next().value!);
        }
      }
      const selected = this.runtime.selectNext(this.runtimeClockMs);
      if (selected) {
        this.options.onSelected?.(selected, frame);
        const parameters = selected.renderParameters;
        if ("relation" in parameters) {
          this.emitCandidate(selected, frame);
        } else {
          const event = this.triggerEvents.get(selected.candidateId);
          this.triggerEvents.delete(selected.candidateId);
          const rendered = event ? renderCrewChiefEvent(event, { voiceMode: "automatic" }) : null;
          if (event && rendered) {
            const callout: RaceEngineerCalloutMessageV3 = { type: "live-engineer-callout", protocolVersion: 3, decisionId: `${event.triggerId}/race-engineer-v3`, candidateId: event.triggerId, family: "race-engineer", sessionId: event.sessionId, timelineEpoch: event.timelineEpoch, sourceSequence: event.sourceSequence, priority: selected.priority, createdSessionTimeMs: selected.createdSessionTimeMs, expiresSessionTimeMs: selected.expiresSessionTimeMs, render: { renderingVersion: "crewchief-v1", text: rendered.text, textKey: event.eventKey, parameters } };
            if (event.eventKey === "lap-completed" && this.armed) {
              this.flushPendingLapVoice();
              this.emitMessage(callout);
              this.pendingLapVoice = { callout, segmentIds: rendered.segmentIds, lapNumber: Number(event.payload.lap ?? event.payload.lapNumber) };
            } else {
              this.flushPendingLapVoice();
              this.emitMessage(callout);
              this.emitMessage(createLiveEngineerVoiceLine(callout, rendered.segmentIds, { mode: "automatic" }));
            }
          } else {
            this.flushPendingLapVoice();
          }
        }
      } else {
        this.flushPendingLapVoice();
      }
    }
    if (frame.simulator === "acc") this.processACCSpotter(frame);
    else if (frame.simulator === "iracing") this.processIRacingSpotter(frame);
    const caution = OPTIONAL_CONTEXT.some((id) => {
      const resolved = values.get(id);
      return resolved?.state === "ok" && isCautionStatus(id, resolved.value);
    });
    if (semanticInput.pace) this.addOpponentFacts(semanticInput.pace, frame);
    const lapState = semanticInput.lapState;
    if (!lapState) return;
    if (!this.armed) {
      this.armed = true;
      this.previousPlayerLap = lapState.lapNumber;
      this.playerLapInvalid = !lapState.currentLapValid;
      return;
    }
    if (lapState.lapNumber === this.previousPlayerLap) {
      this.playerLapInvalid ||= !lapState.currentLapValid;
      return;
    }
    if (lapState.lapNumber < this.previousPlayerLap) return;
    const completedLap = this.previousPlayerLap;
    const eligible = !this.playerLapInvalid && !lapState.inPit && !caution;
    this.previousPlayerLap = lapState.lapNumber;
    this.playerLapInvalid = !lapState.currentLapValid;
    if (!eligible || !semanticInput.pace) return;
    const { pace } = semanticInput;
    const player: PlayerLapForPaceV1 = { sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, lapNumber: completedLap, lapTimeMs: Math.round(lapState.lastLapTimeSeconds * 1000), classId: pace.playerCarClassId, sessionType: pace.sessionType, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, inPit: false, caution: false };
    const candidate = this.tracker.createCandidate(player);
    if (!candidate) return;
    const runtimeCandidate: LiveEngineerRuntimeCandidate = {
      candidateId: candidate.candidateId, actionKey: "opponent-pace-status", cooldownGroup: "opponent-pace", sourceFactIds: [candidate.benchmarkFactId], policyVersion: "opponent-pace-v1", renderParameters: { relation: candidate.relation, scope: frame.simulator === "f1-2025" || player.classId === "overall" ? "overall" : "class", playerLapNumber: player.lapNumber, playerLapTimeMs: player.lapTimeMs, benchmarkLapTimeMs: candidate.benchmarkLapTimeMs, deltaMs: candidate.deltaMs, benchmarkKind: pace.sessionType.toLowerCase() === "race" ? "recent-race-pace" : "session-best" }, sessionId: player.sessionId, timelineEpoch: player.timelineEpoch, sourceSequence: player.sourceSequence, priority: candidate.priority, createdSessionTimeMs: observedMs(frame.observedAt), expiresSessionTimeMs: observedMs(frame.observedAt) + 12_000,
    };
    const submission = this.runtime.submit(runtimeCandidate);
    this.options.onCandidate?.(runtimeCandidate, frame);
    this.options.onDecision?.(runtimeCandidate, submission.reason, frame);
    const selected = batchSelection ? null : this.runtime.selectNext(observedMs(frame.observedAt));
    if (!selected) return;
    this.options.onSelected?.(selected, frame);
    this.emitCandidate(selected, frame);
  }

  handle(message: LiveEngineerVoiceRequestV3 | LiveEngineerDeliveryStatusV3): LiveEngineerVoiceLineMessageV3 | void {
    if (message.type === "live-engineer-delivery-status") {
      const previous = this.diagnostics.get(message.deliveryId);
      if (previous && ["completed", "failed", "muted", "preempted", "unsupported"].includes(previous)) return;
      this.diagnostics.delete(message.deliveryId);
      this.diagnostics.set(message.deliveryId, message.status);
      while (this.diagnostics.size > 64) this.diagnostics.delete(this.diagnostics.keys().next().value!);
      return;
    }
    const callout = this.decisions.get(message.decisionId);
    if (!callout || !this.latest || callout.sessionId !== String(this.latest.sessionId ?? "") || callout.timelineEpoch !== this.timelineEpoch || callout.expiresSessionTimeMs <= observedMs(this.latest.observedAt)) return;
    const render = renderOpponentPace(callout.render.parameters, { voiceMode: "exact-response" });
    if (!render.segmentIds.length || !this.currentContextEligible()) return;
    return createLiveEngineerVoiceLine(callout, render.segmentIds, { mode: "exact-response", requestId: message.requestId });
  }

  reset(): void {
    this.tracker.reset(this.timelineEpoch);
    this.spotter.reset();
    this.accSpotterCars.clear();
    this.decisions.clear();
    this.diagnostics.clear();
    this.triggerEvents.clear();
    this.triggerDiagnostics.length = 0;
    this.latest = null;
    this.slots.clear();
    this.armed = false;
    this.previousPlayerLap = 0;
    this.playerLapInvalid = false;
    this.previousCompetitorLaps.clear();
    this.paceAvailable = false;
    this.lastPaceLossSequence = -1;
    this.pendingLapVoice = null;
  }
  private addOpponentFacts(pace: LiveEngineerPaceInput, frame: LiveResolvedSemanticFrame): void {
    const {
      playerCarIndex, competitorCarIndexes: indexes, competitorDriverIds: ids,
      competitorDriverNames: names, competitorClassIds: classes, competitorClassNames: classNames,
      competitorLaps: laps, competitorPitStatuses: pits, competitorTrackLocations: locations,
      competitorLastLapTimes: times, competitorLastLapValidity: valids, competitorConnected: connected,
    } = pace;
    const iracing = frame.simulator === "iracing";
    const f1 = frame.simulator === "f1-2025";
    for (let i = 0; i < indexes.length; i += 1) {
      const index = indexes[i];
      const lap = laps[i];
      const time = times[i];
      const inPit = isPitStatus(pits[i]);
      const valid = iracing ? locations![i] === "track" : valids![i] === true && (f1 || (connected![i] === true && locations![i] === "track"));
      if (index === playerCarIndex || !finitePositive(lap) || !finitePositive(time) || !valid || inPit) continue;
      const participantId = String(ids[i]);
      const gameId = frame.simulator;
      const fact: OpponentLapFactV1 = { factId: `${gameId}/${frame.sessionId ?? "none"}/${frame.streamId}/${index}/${lap}`, gameId, sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, participantId, participantName: String(names[i]), classId: String(classes[i]), className: String(classNames[i]), lapNumber: lap, lapTimeMs: Math.round(time * 1000), valid: true, inPit: false, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, sourceQuality: iracing ? "conservative-inference" : "native-validity" };
      const previous = this.previousCompetitorLaps.get(participantId);
      this.previousCompetitorLaps.set(participantId, lap);
      if (previous !== undefined && lap <= previous) continue;
      this.tracker.addFact(fact);
    }
  }
  private processACCSpotter(frame: LiveResolvedSemanticFrame): void {
    if (frame.opponentSource && frame.opponentSource.state !== "available") {
      this.spotter.reset();
      this.accSpotterCars.clear();
      return;
    }
    const read = (id: string): ResolvedValue<unknown> | undefined => {
      const index = this.slots.get(id);
      return index === undefined ? undefined : frame.values[index];
    };
    const scalar = (id: string): number | undefined => {
      const value = read(id);
      return value?.state === "ok" && value.freshness === "fresh" && finite(value.value) ? value.value : undefined;
    };
    const stringScalar = (id: string): string | undefined => {
      const value = read(id);
      return value?.state === "ok" && value.freshness === "fresh" && typeof value.value === "string" ? value.value : undefined;
    };
    const array = (id: string): readonly unknown[] | undefined => {
      const value = read(id);
      return value?.state === "ok" && value.freshness === "fresh" && Array.isArray(value.value) ? value.value : undefined;
    };
    const playerX = scalar("motion.position-x");
    const playerZ = scalar("motion.position-z");
    const playerSpeed = scalar("motion.speed");
    const yaw = scalar("motion.yaw");
    const playerIndex = scalar("identity.player-car-index");
    const playerPit = stringScalar("race.pit-status");
    const phase = scalar("session.session-state");
    const indexes = array("race.competitor.car-index");
    const connected = array("race.competitor.connected");
    const positionsX = array("motion.competitor.position-x");
    const positionsZ = array("motion.competitor.position-z");
    const speeds = array("motion.competitor.speed");
    const pits = array("race.competitor.pit-status");
    if ([playerX, playerZ, playerSpeed, yaw, playerIndex, phase].some((value) => value === undefined) || !playerPit || !indexes || !connected || !positionsX || !positionsZ || !speeds || !pits) {
      this.spotter.reset();
      this.accSpotterCars.clear();
      return;
    }
    if (indexes.length === 0 || indexes.length > 64 || !indexes.every((index) => finite(index) && Number.isInteger(index) && index >= 0) ||
      new Set(indexes).size !== indexes.length || !indexes.includes(playerIndex) || connected[indexes.indexOf(playerIndex)] !== true ||
      new Set([indexes.length, connected.length, positionsX.length, positionsZ.length, speeds.length, pits.length]).size !== 1 ||
      !positionsX.every(finite) || !positionsZ.every(finite) || !speeds.every(finite) || !connected.every((value) => typeof value === "boolean") || !pits.every((value) => typeof value === "string")) {
      this.spotter.reset();
      this.accSpotterCars.clear();
      return;
    }
    // A disappeared or disconnected row is lost evidence, not physical clearance.
    for (let i = 0; i < indexes.length; i += 1) {
      if (connected[i] === true) this.accSpotterCars.delete(indexes[i] as number);
    }
    if (this.accSpotterCars.size) this.spotter.reset();
    this.accSpotterCars.clear();
    const pitContext = isPitStatus(playerPit);
    const formationLap = phase === 2 || phase === 3 || phase === 4;
    const cautionContext = OPTIONAL_CONTEXT.some((id) => {
      const value = read(id);
      return value?.state === "ok" && isCautionStatus(id, value.value);
    });
    const opponents = [];
    for (let i = 0; i < indexes.length; i += 1) {
      if (connected[i] === true && indexes[i] !== playerIndex) this.accSpotterCars.add(indexes[i] as number);
      if (indexes[i] === playerIndex || connected[i] !== true || isPitStatus(pits[i]) || !finite(positionsX[i]) || !finite(positionsZ[i]) || !finite(speeds[i])) continue;
      opponents.push({ id: String(indexes[i]), x: positionsX[i] as number, z: positionsZ[i] as number, speedMps: speeds[i] as number });
    }
    const events = this.spotter.update({ sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: frame.sequence, sessionTimeMs: this.runtimeClockMs, player: { x: playerX as number, z: playerZ as number, rotationRad: yaw as number, speedMps: playerSpeed as number, widthM: 1.8, lengthM: 4.8 }, opponents, pitContext, formationLap: formationLap || phase !== 5, cautionContext });
    if (phase !== 5) return;
    this.emitSpotterEvents(events, frame);
  }



  private processIRacingSpotter(frame: LiveResolvedSemanticFrame): void {
    const index = this.slots.get("identity.car-left-right");
    const value = index === undefined ? undefined : frame.values[index];
    if (value?.state !== "ok" || value.freshness !== "fresh" || !finite(value.value)) {
      this.spotter.reset();
      return;
    }
    const events = this.spotter.updateNative({
      sessionId: String(frame.sessionId ?? ""),
      timelineEpoch: this.timelineEpoch,
      sourceSequence: frame.sequence,
      sessionTimeMs: this.runtimeClockMs,
      carLeftRight: value.value,
    });
    this.emitSpotterEvents(events, frame);
  }

  private emitSpotterEvents(events: readonly { state: Exclude<import("../../shared/racing/live/spotter-contracts").SpotterStateV1, "clear">; side: "left" | "right"; overlapCount: number; sourceSequence: number; sessionTimeMs: number; opponentIds: readonly string[] }[], frame: LiveResolvedSemanticFrame): void {
    for (const event of events) {
      this.options.onSpotterEvent?.(event, frame);
      const rendered = renderSpotter(event.state);
      const candidateId = `${frame.sessionId ?? "none"}/${this.timelineEpoch}/${event.sourceSequence}/${event.state}/${event.opponentIds.join(",")}`;
      const callout: SpotterCalloutMessageV3 = { type: "live-engineer-callout", protocolVersion: 3, decisionId: `${candidateId}/spotter-v1`, candidateId, family: "spotter", sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: event.sourceSequence, priority: "high", createdSessionTimeMs: event.sessionTimeMs, expiresSessionTimeMs: event.sessionTimeMs + 2_000, render: { renderingVersion: "spotter-v1", textKey: rendered.textKey as SpotterCalloutMessageV3["render"]["textKey"], parameters: { state: event.state, overlapCount: event.opponentIds.length } } };
      this.emitMessage(callout);
      this.emitMessage(createLiveEngineerVoiceLine(callout, rendered.segmentIds, { mode: "automatic" }));
    }
  }

  private emitCandidate(candidate: LiveEngineerRuntimeCandidate, frame: LiveResolvedSemanticFrame): void {
    const parameters = candidate.renderParameters;
    if (!("relation" in parameters)) return;
    const chainedLap = this.pendingLapVoice?.lapNumber === parameters.playerLapNumber
      && this.pendingLapVoice.callout.sessionId === candidate.sessionId
      && this.pendingLapVoice.callout.timelineEpoch === candidate.timelineEpoch
      ? this.pendingLapVoice
      : null;
    if (!chainedLap) this.flushPendingLapVoice();
    const rendered = renderOpponentPace(parameters, { continuation: chainedLap !== null });
    const callout: OpponentPaceCalloutMessageV3 = { type: "live-engineer-callout", protocolVersion: 3, decisionId: `${candidate.candidateId}/opponent-pace-v1`, candidateId: candidate.candidateId, family: "opponent-pace", sessionId: candidate.sessionId, timelineEpoch: candidate.timelineEpoch, sourceSequence: candidate.sourceSequence, priority: candidate.priority, createdSessionTimeMs: observedMs(frame.observedAt), expiresSessionTimeMs: observedMs(frame.observedAt) + 12_000, render: { renderingVersion: "opponent-pace-v1", textKey: rendered.textKey as OpponentPaceCalloutMessageV3["render"]["textKey"], parameters } };
    this.decisions.set(callout.decisionId, callout);
    while (this.decisions.size > 64) this.decisions.delete(this.decisions.keys().next().value!);
    this.emitMessage(callout);
    this.emitMessage(createLiveEngineerVoiceLine(callout, chainedLap ? [...chainedLap.segmentIds, ...rendered.segmentIds] : rendered.segmentIds, { mode: "automatic" }));
    if (chainedLap) this.pendingLapVoice = null;
  }

  private flushPendingLapVoice(): void {
    if (!this.pendingLapVoice) return;
    const pending = this.pendingLapVoice;
    this.pendingLapVoice = null;
    this.emitMessage(createLiveEngineerVoiceLine(pending.callout, pending.segmentIds, { mode: "automatic" }));
  }

  private currentContextEligible(): boolean {
    if (!this.latest || !this.paceAvailable) return false;
    const values = this.latest.values;
    const ids = ["race.pit-status", "race.on-pit-road", "race.safety-car-status", "race.flag-status", "session.session-flags"];
    for (const id of ids) {
      const index = this.slots.get(id);
      const value = index === undefined ? undefined : values[index];
      if (value?.state === "ok" && (id === "race.pit-status" || id === "race.on-pit-road" ? isPitStatus(value.value) : isCautionStatus(id, value.value))) return false;
    }
    return true;
  }

}
