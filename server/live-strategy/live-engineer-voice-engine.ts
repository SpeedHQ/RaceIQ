import type { GameId } from "../../shared/games/ids";
import { isLiveEngineerGameId } from "../../shared/telemetry/live/semantics";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import type { LiveResolvedSemanticFrame } from "../telemetry/live-projector";
import { extractLiveEngineerSemanticInput } from "./live-engineer-semantic-input";
import {
  createLiveEngineerVoiceLine as createVoiceLine,
  type LiveEngineerCalloutMessageV2,
  type LiveEngineerDeliveryStatusV2,
  type LiveEngineerVoiceLineMessageV2,
  type LiveEngineerVoiceRequestV2,
  type OpponentPaceCalloutMessageV2,
  type SpotterCalloutMessageV2,
} from "../../shared/racing/live/engineer-contracts";
import { OpponentPaceTracker, type OpponentLapFactV1, type PlayerLapForPaceV1 } from "./opponent-pace-tracker";
import { LiveEngineerRuntime, type LiveEngineerRuntimeCandidate } from "./live-engineer-runtime";
import { renderOpponentPace, renderSpotter } from "./live-engineer-renderer";
import { SpotterTracker } from "./spotter-tracker";

export type LiveEngineerVoiceLineOptions =
  | { mode: "automatic" }
  | { mode: "exact-response"; requestId: string };

export interface LiveEngineerVoiceEngineOptions {
  emit: (message: LiveEngineerCalloutMessageV2 | LiveEngineerVoiceLineMessageV2) => void;
}


const OPTIONAL_CONTEXT = ["race.safety-car-status", "race.flag-status", "session.session-flags"] as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finitePositive = (value: unknown): value is number => finite(value) && value > 0;
const boolish = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : typeof value === "string" ? ["true", "active", "caution", "yellow", "red", "pit", "off-track"].includes(value.toLowerCase()) : undefined;
const isPitStatus = (value: unknown): boolean => typeof value === "string" ? ["in_pit", "pit_lane", "pit", "pit-stall"].includes(value.toLowerCase()) : value === true;
const isCautionStatus = (semanticId: string, value: unknown): boolean => {
  if (semanticId === "race.safety-car-status") return finite(value) ? value !== 0 : value === true;
  if (semanticId === "session.session-flags") return finite(value) ? (value & ((1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9))) !== 0 : false;
  return typeof value === "string" ? ["yellow", "red", "caution"].includes(value.toLowerCase()) : value === true;
};
const arrayOf = <T>(value: unknown): readonly T[] | null => Array.isArray(value) ? value as readonly T[] : null;
const observedMs = (timestamp: LiveResolvedSemanticFrame["observedAt"]): number => "milliseconds" in timestamp ? timestamp.milliseconds : Number(timestamp.nanoseconds / 1_000_000n);

export function createLiveEngineerVoiceLine(
  callout: LiveEngineerCalloutMessageV2,
  segmentIds: readonly string[],
  options: LiveEngineerVoiceLineOptions,
): LiveEngineerVoiceLineMessageV2 {
  return createVoiceLine(callout, segmentIds, options);
}

export class LiveEngineerVoiceEngine {
  private readonly emitMessage: LiveEngineerVoiceEngineOptions["emit"];
  private readonly tracker = new OpponentPaceTracker();
  private readonly spotter = new SpotterTracker();
  private readonly runtime = new LiveEngineerRuntime({ maxQueue: 3, now: () => this.runtimeClockMs });
  private runtimeClockMs = 0;
  private readonly decisions = new Map<string, OpponentPaceCalloutMessageV2>();
  private readonly diagnostics = new Map<string, LiveEngineerDeliveryStatusV2["status"]>();
  private latest: LiveResolvedSemanticFrame | null = null;
  private slots = new Map<string, number>();
  private streamKey = "";
  private timelineEpoch = 0;
  private armed = false;
  private previousPlayerLap = 0;
  private playerLapInvalid = false;
  private previousLapPaceAvailable = false;
  private readonly previousCompetitorLaps = new Map<string, number>();

  constructor(options: LiveEngineerVoiceEngineOptions) {
    this.emitMessage = options.emit;
  }

  consume(frame: LiveResolvedSemanticFrame): void {
    const key = `${frame.simulator}/${frame.sessionId ?? "none"}/${frame.streamId}`;
    if (key !== this.streamKey) {
      this.reset();
      this.streamKey = key;
      this.timelineEpoch += 1;
      this.tracker.reset(this.timelineEpoch);
      this.runtime.reset(String(frame.sessionId ?? ""), this.timelineEpoch);
    }
    if (!isLiveEngineerGameId(frame.simulator)) return;
    const semanticInput = extractLiveEngineerSemanticInput(frame);
    const values = new Map(semanticInput.values);
    if (!this.slots.size) this.slots = new Map(frame.ids.map((id, index) => [id, index]));
    this.runtimeClockMs = observedMs(frame.observedAt);
    this.latest = frame;
    if (frame.simulator === "iracing") {
      const nativeIndex = this.slots.get("identity.car-left-right");
      const native = nativeIndex === undefined ? undefined : frame.values[nativeIndex];
      if (native?.state === "ok" && finite(native.value)) this.emitSpotterEvents(this.spotter.updateNative({ sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: frame.sequence, sessionTimeMs: this.runtimeClockMs, carLeftRight: Math.trunc(native.value) }), frame);
    }
    if (frame.simulator === "acc") this.processACCSpotter(frame);
    const caution = OPTIONAL_CONTEXT.some((id) => {
      const resolved = values.get(id);
      return resolved?.state === "ok" && isCautionStatus(id, resolved.value);
    });
    if (semanticInput.pace) this.addOpponentFacts(values, frame, semanticInput.pace.playerCarIndex);
    const lapState = semanticInput.lapState;
    if (!lapState) return;
    if (!this.armed) {
      this.armed = true;
      this.previousPlayerLap = lapState.lapNumber;
      this.playerLapInvalid = !lapState.currentLapValid;
      this.previousLapPaceAvailable = semanticInput.pace !== null;
      return;
    }
    if (lapState.lapNumber === this.previousPlayerLap) {
      this.playerLapInvalid ||= !lapState.currentLapValid;
      this.previousLapPaceAvailable &&= semanticInput.pace !== null;
      return;
    }
    if (lapState.lapNumber < this.previousPlayerLap) return;
    const completedLap = this.previousPlayerLap;
    const paceAvailableForCompletedLap = this.previousLapPaceAvailable;
    const eligible = !this.playerLapInvalid && !lapState.inPit && !caution;
    this.previousPlayerLap = lapState.lapNumber;
    this.playerLapInvalid = !lapState.currentLapValid;
    this.previousLapPaceAvailable = semanticInput.pace !== null;
    if (!eligible || !paceAvailableForCompletedLap || !semanticInput.pace) return;
    const { pace } = semanticInput;
    const player: PlayerLapForPaceV1 = { sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, lapNumber: completedLap, lapTimeMs: Math.round(lapState.lastLapTimeSeconds * 1000), classId: pace.playerCarClassId, sessionType: pace.sessionType, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, inPit: false, caution: false };
    const candidate = this.tracker.createCandidate(player);
    if (!candidate) return;
    const runtimeCandidate: LiveEngineerRuntimeCandidate = {
      candidateId: candidate.candidateId, actionKey: "opponent-pace-status", cooldownGroup: "opponent-pace", sourceFactIds: [candidate.benchmarkFactId], policyVersion: "opponent-pace-v1", renderParameters: { relation: candidate.relation, scope: player.classId === "overall" ? "overall" : "class", playerLapNumber: player.lapNumber, playerLapTimeMs: player.lapTimeMs, benchmarkLapTimeMs: candidate.benchmarkLapTimeMs, deltaMs: candidate.deltaMs, benchmarkKind: pace.sessionType.toLowerCase() === "race" ? "recent-race-pace" : "session-best" }, sessionId: player.sessionId, timelineEpoch: player.timelineEpoch, sourceSequence: player.sourceSequence, priority: candidate.priority, createdSessionTimeMs: observedMs(frame.observedAt), expiresSessionTimeMs: observedMs(frame.observedAt) + 12_000,
    };
    this.runtime.submit(runtimeCandidate);
    const selected = this.runtime.selectNext(observedMs(frame.observedAt));
    if (!selected) return;
    this.emitCandidate(selected, frame);
  }

  handle(message: LiveEngineerVoiceRequestV2 | LiveEngineerDeliveryStatusV2): LiveEngineerVoiceLineMessageV2 | void {
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
    this.decisions.clear();
    this.diagnostics.clear();
    this.latest = null;
    this.slots.clear();
    this.armed = false;
    this.previousPlayerLap = 0;
    this.playerLapInvalid = false;
    this.previousLapPaceAvailable = false;
    this.previousCompetitorLaps.clear();
  }
  private addOpponentFacts(values: Map<string, ResolvedValue<unknown>>, frame: LiveResolvedSemanticFrame, playerIndex: number): void {
    const indexes = arrayOf<number>(values.get("race.competitor.car-index")!.value);
    const ids = arrayOf<unknown>(values.get("race.competitor.driver-id")!.value);
    const names = arrayOf<unknown>(values.get("race.competitor.driver-name")!.value);
    const classes = arrayOf<unknown>(values.get("race.competitor.car-class-id")!.value);
    const classNames = arrayOf<unknown>(values.get("race.competitor.car-class-name")!.value);
    const laps = arrayOf<number>(values.get("race.competitor.laps-complete")!.value);
    const pits = arrayOf<unknown>(values.get("race.competitor.pit-status")!.value);
    const times = arrayOf<number>(values.get("timing.competitor.last-lap-time")!.value);
    const valids = arrayOf<unknown>(values.get("timing.competitor.last-lap-valid")?.value);
    const connected = arrayOf<unknown>(values.get("race.competitor.connected")?.value);
    const surfaces = arrayOf<unknown>(values.get("race.competitor.track-location")?.value);
    const all = [indexes, ids, names, classes, classNames, laps, pits, times, ...(frame.simulator === "acc" ? [connected] : [surfaces])];
    if (all.some((list) => !list || list.length !== indexes?.length || list.length > 64)) return;
    for (let i = 0; i < indexes!.length; i += 1) {
      const index = indexes![i];
      const lap = laps![i];
      const time = times![i];
      const inPit = isPitStatus(pits![i]);
      const nativeValid = frame.simulator === "acc" && valids ? boolish(valids[i]) === true : false;
      const surface = surfaces?.[i];
      const conservativeValid = frame.simulator === "iracing" && surface === "track" && !inPit;
      const valid = nativeValid || conservativeValid;
      if (!finite(index) || index === playerIndex || !finitePositive(lap) || !finitePositive(time) || !valid || inPit || (frame.simulator === "acc" && connected![i] !== true) || typeof classes![i] !== "string") continue;
      const participantId = String(ids![i] ?? index);
      const fact: OpponentLapFactV1 = { factId: `${frame.simulator}/${frame.sessionId ?? "none"}/${frame.streamId}/${index}/${lap}`, gameId: frame.simulator as GameId, sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, participantId, participantName: String(names![i] ?? participantId), classId: String(classes![i]), className: String(classNames![i] ?? classes![i]), lapNumber: lap, lapTimeMs: Math.round(time * 1000), valid: true, inPit: false, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, sourceQuality: nativeValid ? "native-validity" : "conservative-inference" };
      const previous = this.previousCompetitorLaps.get(participantId);
      this.previousCompetitorLaps.set(participantId, lap);
      if (previous !== undefined && lap <= previous) continue;
      this.tracker.addFact(fact);
    }
  }
  private processACCSpotter(frame: LiveResolvedSemanticFrame): void {
    const read = (id: string): ResolvedValue<unknown> | undefined => {
      const index = this.slots.get(id);
      return index === undefined ? undefined : frame.values[index];
    };
    const scalar = (id: string): number | undefined => {
      const value = read(id);
      return value?.state === "ok" && finite(value.value) ? value.value : undefined;
    };
    const stringScalar = (id: string): string | undefined => {
      const value = read(id);
      return value?.state === "ok" && typeof value.value === "string" ? value.value : undefined;
    };
    const array = (id: string): readonly unknown[] | undefined => {
      const value = read(id);
      return value?.state === "ok" && Array.isArray(value.value) ? value.value : undefined;
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
      return;
    }
    if (new Set([indexes.length, connected.length, positionsX.length, positionsZ.length, speeds.length, pits.length]).size !== 1) {
      this.spotter.reset();
      return;
    }
    const pitContext = isPitStatus(playerPit);
    const formationLap = phase === 2 || phase === 3 || phase === 4;
    const cautionContext = OPTIONAL_CONTEXT.some((id) => {
      const value = read(id);
      return value?.state === "ok" && isCautionStatus(id, value.value);
    });
    const opponents = [];
    for (let i = 0; i < indexes.length; i += 1) {
      if (indexes[i] === playerIndex || connected[i] !== true || isPitStatus(pits[i]) || !finite(positionsX[i]) || !finite(positionsZ[i]) || !finite(speeds[i])) continue;
      opponents.push({ id: String(indexes[i]), x: positionsX[i] as number, z: positionsZ[i] as number, speedMps: speeds[i] as number });
    }
    const events = this.spotter.update({ sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: frame.sequence, sessionTimeMs: this.runtimeClockMs, player: { x: playerX as number, z: playerZ as number, rotationRad: yaw as number, speedMps: playerSpeed as number, widthM: 1.8, lengthM: 4.8 }, opponents, pitContext, formationLap: formationLap || phase !== 5, cautionContext });
    if (phase !== 5) return;
    this.emitSpotterEvents(events, frame);
  }



  private emitSpotterEvents(events: readonly { state: Exclude<import("../../shared/racing/live/spotter-contracts").SpotterStateV1, "clear">; side: "left" | "right"; overlapCount: number; sourceSequence: number; sessionTimeMs: number; opponentIds: readonly string[] }[], frame: LiveResolvedSemanticFrame): void {
    for (const event of events) {
      const rendered = renderSpotter(event.state);
      const candidateId = `${frame.sessionId ?? "none"}/${this.timelineEpoch}/${event.sourceSequence}/${event.state}/${event.opponentIds.join(",")}`;
      const callout: SpotterCalloutMessageV2 = { type: "live-engineer-callout", protocolVersion: 2, decisionId: `${candidateId}/spotter-v1`, candidateId, family: "spotter", sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: event.sourceSequence, priority: "high", createdSessionTimeMs: event.sessionTimeMs, expiresSessionTimeMs: event.sessionTimeMs + 2_000, render: { renderingVersion: "spotter-v1", textKey: rendered.textKey as SpotterCalloutMessageV2["render"]["textKey"], parameters: { state: event.state, side: event.side, overlapCount: event.overlapCount } } };
      this.emitMessage(callout);
      this.emitMessage(createLiveEngineerVoiceLine(callout, rendered.segmentIds, { mode: "automatic" }));
    }
  }

  private emitCandidate(candidate: LiveEngineerRuntimeCandidate, frame: LiveResolvedSemanticFrame): void {
    const rendered = renderOpponentPace(candidate.renderParameters);
    const callout: OpponentPaceCalloutMessageV2 = { type: "live-engineer-callout", protocolVersion: 2, decisionId: `${candidate.candidateId}/opponent-pace-v1`, candidateId: candidate.candidateId, family: "opponent-pace", sessionId: candidate.sessionId, timelineEpoch: candidate.timelineEpoch, sourceSequence: candidate.sourceSequence, priority: candidate.priority, createdSessionTimeMs: observedMs(frame.observedAt), expiresSessionTimeMs: observedMs(frame.observedAt) + 12_000, render: { renderingVersion: "opponent-pace-v1", textKey: rendered.textKey as OpponentPaceCalloutMessageV2["render"]["textKey"], parameters: candidate.renderParameters } };
    this.decisions.set(callout.decisionId, callout);
    while (this.decisions.size > 64) this.decisions.delete(this.decisions.keys().next().value!);
    this.emitMessage(callout);
    this.emitMessage(createLiveEngineerVoiceLine(callout, rendered.segmentIds, { mode: "automatic" }));
  }

  private currentContextEligible(): boolean {
    if (!this.latest) return false;
    const values = this.latest.values;
    const ids = this.latest.simulator === "iracing" ? ["race.on-pit-road", "race.safety-car-status", "race.flag-status", "session.session-flags"] : ["race.pit-status", "race.safety-car-status", "race.flag-status", "session.session-flags"];
    for (const id of ids) {
      const index = this.slots.get(id);
      const value = index === undefined ? undefined : values[index];
      if (value?.state === "ok" && (id === "race.pit-status" || id === "race.on-pit-road" ? isPitStatus(value.value) : isCautionStatus(id, value.value))) return false;
    }
    return true;
  }

}
