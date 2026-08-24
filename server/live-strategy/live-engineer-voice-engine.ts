import type { GameId } from "../../shared/games/ids";
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

const PACE_REQUIRED = [
  "identity.player-car-index", "identity.player-car-class-id", "identity.player-track-surface",
  "timing.lap-number", "timing.last-lap", "race.pit-status", "session.session-type",
  "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name",
  "race.competitor.car-class-id", "race.competitor.car-class-name", "race.competitor.laps-complete",
  "race.competitor.pit-status", "race.competitor.track-location",
  "timing.competitor.last-lap-time",
] as const;

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
    if (frame.simulator === "f1-2025") this.processF1Spotter(frame);
    for (const id of PACE_REQUIRED) {
      const index = this.slots.get(id);
      const resolved = index === undefined ? undefined : frame.values[index];
      if (!resolved || resolved.state !== "ok") return;
      values.set(id, resolved);
    }
    for (const id of ["timing.competitor.last-lap-valid"] as const) {
      const index = this.slots.get(id);
      const resolved = index === undefined ? undefined : frame.values[index];
      if (resolved?.state === "ok") values.set(id, resolved);
    }
    const playerLap = values.get("timing.lap-number")!.value;
    const playerLastLap = values.get("timing.last-lap")!.value;
    const playerClass = values.get("identity.player-car-class-id")!.value;
    const sessionType = values.get("session.session-type")!.value;
    const playerIndex = values.get("identity.player-car-index")!.value;
    if (!finitePositive(playerLap) || !finitePositive(playerLastLap) || typeof playerClass !== "string" || typeof sessionType !== "string" || !finite(playerIndex)) return;
    const playerPit = isPitStatus(values.get("race.pit-status")!.value);
    const playerValid = this.resolvedBool(values.get("timing.current-lap-valid"));
    const trackSurface = values.get("identity.player-track-surface")!.value;
    const conservativeValid = typeof trackSurface === "string" ? !["off-track", "pit-lane", "pit"].includes(trackSurface.toLowerCase()) : undefined;
    const valid = playerValid ?? conservativeValid;
    const caution = OPTIONAL_CONTEXT.some((id) => {
      const index = this.slots.get(id);
      const resolved = index === undefined ? undefined : frame.values[index];
      return resolved?.state === "ok" && isCautionStatus(id, resolved.value);
    });
    if (valid === undefined) return;
    this.addOpponentFacts(values, frame, playerIndex);
    if (!this.armed) {
      this.armed = true;
      this.previousPlayerLap = playerLap;
      return;
    }
    if (playerLap <= this.previousPlayerLap) return;
    const eligible = !this.playerLapInvalid && valid && !playerPit && !caution;
    this.previousPlayerLap = playerLap;
    this.playerLapInvalid = false;
    if (!eligible) return;
    const player: PlayerLapForPaceV1 = { sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, lapNumber: playerLap, lapTimeMs: Math.round(playerLastLap * 1000), classId: playerClass, sessionType, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, inPit: false, caution: false };
    const candidate = this.tracker.createCandidate(player);
    if (!candidate) return;
    const runtimeCandidate: LiveEngineerRuntimeCandidate = {
      candidateId: candidate.candidateId, actionKey: "opponent-pace-status", cooldownGroup: "opponent-pace", sourceFactIds: [candidate.benchmarkFactId], policyVersion: "opponent-pace-v1", renderParameters: { relation: candidate.relation, scope: player.classId === "overall" ? "overall" : "class", playerLapNumber: player.lapNumber, playerLapTimeMs: player.lapTimeMs, benchmarkLapTimeMs: candidate.benchmarkLapTimeMs, deltaMs: candidate.deltaMs, benchmarkKind: sessionType.toLowerCase() === "race" ? "recent-race-pace" : "session-best" }, sessionId: player.sessionId, timelineEpoch: player.timelineEpoch, sourceSequence: player.sourceSequence, priority: candidate.priority, createdSessionTimeMs: observedMs(frame.observedAt), expiresSessionTimeMs: observedMs(frame.observedAt) + 12_000,
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
    const surfaces = arrayOf<unknown>(values.get("race.competitor.track-location")?.value);
    const all = [indexes, ids, names, classes, classNames, laps, pits, times];
    if (all.some((list) => !list || list.length !== indexes?.length || list.length > 64)) return;
    for (let i = 0; i < indexes!.length; i += 1) {
      const index = indexes![i];
      const lap = laps![i];
      const time = times![i];
      const inPit = isPitStatus(pits![i]);
      const nativeValid = valids ? boolish(valids[i]) === true : false;
      const surface = surfaces?.[i];
      const conservativeValid = frame.simulator === "iracing" && typeof surface === "number" && surface >= 0 && surface <= 3 && !inPit;
      const valid = nativeValid || conservativeValid;
      if (!finite(index) || index === playerIndex || !finitePositive(lap) || !finitePositive(time) || !valid || inPit || typeof classes![i] !== "string") continue;
      const participantId = String(ids![i] ?? index);
      const fact: OpponentLapFactV1 = { factId: `${frame.simulator}/${frame.sessionId ?? "none"}/${frame.streamId}/${index}/${lap}`, gameId: frame.simulator as GameId, sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, participantId, participantName: String(names![i] ?? participantId), classId: String(classes![i]), className: String(classNames![i] ?? classes![i]), lapNumber: lap, lapTimeMs: Math.round(time * 1000), valid: true, inPit: false, completedSessionTimeMs: observedMs(frame.observedAt), sourceSequence: frame.sequence, sourceQuality: nativeValid ? "native-validity" : "conservative-inference" };
      const previous = this.previousCompetitorLaps.get(participantId);
      this.previousCompetitorLaps.set(participantId, lap);
      if (previous !== undefined && lap <= previous) continue;
      this.tracker.addFact(fact);
    }
  }

  private processF1Spotter(frame: LiveResolvedSemanticFrame): void {
    const read = (id: string): ResolvedValue<unknown> | undefined => {
      const index = this.slots.get(id);
      return index === undefined ? undefined : frame.values[index];
    };
    const scalarValue = (id: string): number | undefined => {
      const value = read(id);
      return value?.state === "ok" && finite(value.value) ? value.value : undefined;
    };
    const arrayValue = (id: string): readonly unknown[] | undefined => {
      const value = read(id);
      return value?.state === "ok" && Array.isArray(value.value) ? value.value : undefined;
    };
    const playerX = scalarValue("motion.position-x");
    const playerZ = scalarValue("motion.position-z");
    const playerSpeed = scalarValue("motion.speed");
    const yaw = scalarValue("motion.yaw");
    const playerIndex = scalarValue("identity.player-car-index");
    const indexes = arrayValue("race.competitor.car-index");
    const connected = arrayValue("race.competitor.connected");
    const positionsX = arrayValue("race.competitor.position-x");
    const positionsZ = arrayValue("race.competitor.position-z");
    const speeds = arrayValue("race.competitor.speed");
    const pits = arrayValue("race.competitor.pit-status");
    const playerPit = read("race.pit-status")?.state === "ok" && isPitStatus(read("race.pit-status")?.value);
    if ([playerX, playerZ, playerSpeed, yaw, playerIndex].some((value) => value === undefined) || playerPit || !indexes || !connected || !positionsX || !positionsZ || !speeds || !pits || new Set([indexes.length, connected.length, positionsX.length, positionsZ.length, speeds.length, pits.length]).size !== 1) return;
    const opponents = [];
    for (let i = 0; i < indexes.length; i += 1) {
      if (indexes[i] === playerIndex || connected[i] !== true || isPitStatus(pits[i]) || !finite(positionsX[i]) || !finite(positionsZ[i]) || !finite(speeds[i])) continue;
      opponents.push({ id: String(indexes[i]), x: positionsX[i] as number, z: positionsZ[i] as number, speedMps: speeds[i] as number });
    }
    this.emitSpotterEvents(this.spotter.update({ sessionId: String(frame.sessionId ?? ""), timelineEpoch: this.timelineEpoch, sourceSequence: frame.sequence, sessionTimeMs: this.runtimeClockMs, player: { x: playerX as number, z: playerZ as number, rotationRad: yaw as number, speedMps: playerSpeed as number, widthM: 1.8, lengthM: 4.8 }, opponents }), frame);
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
    for (const id of ["race.pit-status", "race.safety-car-status", "race.flag-status", "session.session-flags"]) {
      const index = this.slots.get(id);
      const value = index === undefined ? undefined : values[index];
      if (value?.state === "ok" && (id === "race.pit-status" ? isPitStatus(value.value) : isCautionStatus(id, value.value))) return false;
    }
    return true;
  }

  private resolvedBool(value: ResolvedValue<unknown> | undefined): boolean | undefined {
    if (!value || value.state !== "ok") return undefined;
    return typeof value.value === "boolean" ? value.value : typeof value.value === "number" ? value.value !== 0 : undefined;
  }
}
