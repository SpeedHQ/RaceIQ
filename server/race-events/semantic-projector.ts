import type { GameId } from "../../shared/games/ids";
import type { CautionKind, PitObservationState, RaceSessionPhase } from "../../shared/racing/events/contracts";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import type { CompiledTelemetryResolver, FreshnessState, ResolutionState, SemanticSlot, TelemetryFrameView } from "../../shared/telemetry/resolver/contracts";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getServerGame } from "../games/registry";
import type { FourCornerRaceEventValue, RaceEventObservation, RaceParticipantObservation } from "../games/types";

export const RACE_EVENT_SEMANTIC_IDS = [
  "race.control.phase",
  "race.control.caution-kind",
  "race.player.pit-state",
  "race.pit-service.lifecycle-status",
  "race.pit-service.tire-change-counts",
  "race.pit-service.repair-time-remaining",
] as const;

type RaceEventSemanticId = (typeof RACE_EVENT_SEMANTIC_IDS)[number];
type RepairEvidence = { mandatory: number; optional: number };
function tireWearValue(value: unknown): value is readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const fl = value[0];
  const fr = value[1];
  const rl = value[2];
  const rr = value[3];
  if (
    typeof fl !== "number" ||
    !Number.isFinite(fl) ||
    fl < 0 ||
    fl > 1 ||
    typeof fr !== "number" ||
    !Number.isFinite(fr) ||
    fr < 0 ||
    fr > 1 ||
    typeof rl !== "number" ||
    !Number.isFinite(rl) ||
    rl < 0 ||
    rl > 1 ||
    typeof rr !== "number" ||
    !Number.isFinite(rr) ||
    rr < 0 ||
    rr > 1
  ) {
    return false;
  }
  return true;
}

const tireWearSourceFreshnessByGame = (() => {
  const tireWear = TELEMETRY_CATALOG.variables.find(({ id }) => id === "tires.tire-wear");
  const entries: [string, "continuous" | "pit-snapshot"][] = [];
  for (const [gameId, mapping] of Object.entries(tireWear?.games ?? {})) {
    if (mapping.kind !== "unavailable" && (mapping.freshness === "continuous" || mapping.freshness === "pit-snapshot")) {
      entries.push([gameId, mapping.freshness]);
    }
  }
  return Object.fromEntries(entries) as Partial<Record<GameId, "continuous" | "pit-snapshot">>;
})();

/** Value plus resolver state retained for deterministic detector evidence. */
export interface RaceEventSemanticEvidence<T> {
  readonly value: T | undefined;
  readonly state: ResolutionState;
  readonly freshness: FreshnessState;
  readonly sourceFreshness: "continuous" | "pit-snapshot" | "session-update" | "static" | null;
}

/** Reused canonical event semantics for current packet. Consume synchronously. */
export interface RaceEventSemanticFrame {
  readonly raceControlPhase: RaceEventSemanticEvidence<RaceSessionPhase>;
  readonly cautionKind: RaceEventSemanticEvidence<CautionKind>;
  readonly pitState: RaceEventSemanticEvidence<PitObservationState>;
  readonly pitServiceStatus: RaceEventSemanticEvidence<RaceParticipantObservation["pitServiceStatus"]>;
  readonly tireChangeCounts: RaceEventSemanticEvidence<FourCornerRaceEventValue>;
  readonly repairEvidence: RaceEventSemanticEvidence<RepairEvidence>;
}

type MutableEvidence = {
  value: unknown;
  state: ResolutionState;
  freshness: FreshnessState;
  sourceFreshness: RaceEventSemanticEvidence<unknown>["sourceFreshness"];
};

const EMPTY_EVIDENCE: MutableEvidence = {
  value: undefined,
  state: "missing",
  freshness: "unknown",
  sourceFreshness: null,
};

/** Compiles game-owned canonical semantics once per game and reuses frame state. */
export class RaceEventSemanticProjector implements RaceEventSemanticFrame {
  private resolver: CompiledTelemetryResolver<TelemetryPacket> | null = null;
  private view: TelemetryFrameView<TelemetryPacket> | undefined;
  private gameId: GameId | null = null;
  private sequence = 0;
  private lastObservedAtMs: number | null = null;
  private observedAtMs: ((packet: TelemetryPacket, receivedAtMs: number) => number) | null = null;
  private observation = {
    timestamp: {
      domain: "wall-clock" as "wall-clock" | "session",
      milliseconds: 0,
    },
    updateSequence: 0n,
  };
  private slots = {} as Record<RaceEventSemanticId, SemanticSlot>;
  private readonly evidence = Object.fromEntries(RACE_EVENT_SEMANTIC_IDS.map((id) => [id, { ...EMPTY_EVIDENCE }])) as Record<RaceEventSemanticId, MutableEvidence>;

  project(packet: TelemetryPacket, receivedAtMs: number): RaceEventSemanticFrame {
    const gameId = packet.gameId as GameId;
    if (this.gameId !== gameId || this.resolver === null) this.start(gameId);
    const resolver = this.resolver;
    const observedAtMsForPacket = this.observedAtMs;
    if (resolver === null || observedAtMsForPacket === null) {
      throw new Error("Race-event semantic projector failed to initialize");
    }
    const observedAtMs = observedAtMsForPacket(packet, receivedAtMs);
    if (this.lastObservedAtMs !== null && observedAtMs < this.lastObservedAtMs) {
      this.resetSourceState();
    }
    this.lastObservedAtMs = Number.isFinite(observedAtMs) ? observedAtMs : null;
    this.observation.timestamp.milliseconds = observedAtMs;
    this.observation.updateSequence = BigInt(this.sequence++);
    const view = resolver.createFrameView(packet, this.observation, this.view);
    this.view = view;
    for (const id of RACE_EVENT_SEMANTIC_IDS) {
      const slot = this.slots[id];
      const state = view.resolutionState(slot);
      const freshness = view.freshnessState(slot);
      const evidence = this.evidence[id];
      evidence.value = state === "ok" && freshness === "fresh" ? view.readValue(slot) : undefined;
      evidence.state = state;
      evidence.freshness = freshness;
      evidence.sourceFreshness = view.sourceFreshness(slot);
    }
    return this;
  }

  /** Clears retained source observations before next packet of a new source epoch. */
  resetSourceState(): void {
    this.view?.resetSourceState();
    this.sequence = 0;
    this.lastObservedAtMs = null;
    for (const id of RACE_EVENT_SEMANTIC_IDS) {
      Object.assign(this.evidence[id], EMPTY_EVIDENCE);
    }
  }

  reset(): void {
    this.resetSourceState();
  }
  get raceControlPhase(): RaceEventSemanticEvidence<RaceSessionPhase> {
    return this.evidence["race.control.phase"] as RaceEventSemanticEvidence<RaceSessionPhase>;
  }

  get cautionKind(): RaceEventSemanticEvidence<CautionKind> {
    return this.evidence["race.control.caution-kind"] as RaceEventSemanticEvidence<CautionKind>;
  }

  get pitState(): RaceEventSemanticEvidence<PitObservationState> {
    return this.evidence["race.player.pit-state"] as RaceEventSemanticEvidence<PitObservationState>;
  }

  get pitServiceStatus(): RaceEventSemanticEvidence<RaceParticipantObservation["pitServiceStatus"]> {
    return this.evidence["race.pit-service.lifecycle-status"] as RaceEventSemanticEvidence<RaceParticipantObservation["pitServiceStatus"]>;
  }

  get tireChangeCounts(): RaceEventSemanticEvidence<FourCornerRaceEventValue> {
    return this.evidence["race.pit-service.tire-change-counts"] as RaceEventSemanticEvidence<FourCornerRaceEventValue>;
  }

  get repairEvidence(): RaceEventSemanticEvidence<RepairEvidence> {
    return this.evidence["race.pit-service.repair-time-remaining"] as RaceEventSemanticEvidence<RepairEvidence>;
  }

  private start(gameId: GameId): void {
    this.gameId = gameId;
    this.sequence = 0;
    this.view = undefined;
    this.observation.timestamp.milliseconds = 0;
    this.observation.updateSequence = 0n;
    this.lastObservedAtMs = null;
    const adapter = getServerGame(gameId);
    this.observation.timestamp.domain = adapter.raceEventTimestampDomain;
    this.observedAtMs = adapter.raceEventObservedAtMs;
    this.resolver = compileTelemetryResolver({
      simulator: gameId,
      requested: RACE_EVENT_SEMANTIC_IDS.map((semanticId) => ({ semanticId })),
      derivations: adapter.raceEventDerivations,
    });
    for (const id of RACE_EVENT_SEMANTIC_IDS) this.slots[id] = this.resolver.slot(id);
  }
}

/** Applies canonical player-scoped semantics after game adapter normalization. */
export function applyRaceEventSemanticProjection(observation: RaceEventObservation, semantic: RaceEventSemanticFrame, sample?: SemanticTelemetrySample): RaceEventObservation {
  const phase = semantic.raceControlPhase.state === "ok" && semantic.raceControlPhase.freshness === "fresh" ? semantic.raceControlPhase.value : undefined;
  const caution = semantic.cautionKind.state === "ok" && semantic.cautionKind.freshness === "fresh" ? semantic.cautionKind.value : undefined;
  if (phase !== undefined) observation.sessionPhase = phase;
  if (caution !== undefined) observation.cautionKind = caution;
  if (phase !== undefined || caution !== undefined) {
    observation.raceControlEvidence = "authoritative";
  }
  const tireWearFreshness = tireWearSourceFreshnessByGame[observation.gameId as GameId];
  const tireWearSource = sample?.values["tires.tire-wear"];
  const tireWear = tireWearFreshness !== undefined && tireWearValue(tireWearSource) ? tireWearSource : undefined;
  for (const participant of observation.participants) {
    if (participant.participantKind !== "player") continue;
    const pitState = semantic.pitState.state === "ok" && semantic.pitState.freshness === "fresh" ? semantic.pitState.value : undefined;
    const pitServiceStatus = semantic.pitServiceStatus.state === "ok" && semantic.pitServiceStatus.freshness === "fresh" ? semantic.pitServiceStatus.value : undefined;
    const tireChangeCounts = semantic.tireChangeCounts.state === "ok" && semantic.tireChangeCounts.freshness === "fresh" ? semantic.tireChangeCounts.value : undefined;
    const repairEvidence = semantic.repairEvidence.state === "ok" && semantic.repairEvidence.freshness === "fresh" ? semantic.repairEvidence.value : undefined;
    if (pitState !== undefined) participant.pitState = pitState;
    if (pitServiceStatus !== undefined) participant.pitServiceStatus = pitServiceStatus;
    if (tireChangeCounts !== undefined) participant.tireChangeCounts = tireChangeCounts;
    if (repairEvidence !== undefined) participant.repairRemainingSeconds = repairEvidence;
    if (tireWear !== undefined) {
      const currentTireWear = participant.tireWear;
      if (currentTireWear === null) {
        participant.tireWear = {
          fl: tireWear[0],
          fr: tireWear[1],
          rl: tireWear[2],
          rr: tireWear[3],
        };
      } else {
        currentTireWear.fl = tireWear[0];
        currentTireWear.fr = tireWear[1];
        currentTireWear.rl = tireWear[2];
        currentTireWear.rr = tireWear[3];
      }
      participant.tireWearFreshness = tireWearFreshness;
    }
    break;
  }
  return observation;
}
