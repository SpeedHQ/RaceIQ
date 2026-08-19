import type { RaceEventObservation, RaceParticipantObservation } from "../../server/games/types";
import type { RaceEventLapEvaluation } from "../../server/race-events/types";

export function participant(overrides: Partial<RaceParticipantObservation> = {}): RaceParticipantObservation {
  return {
    participantId: "local-player",
    participantKind: "player",
    sourceId: null,
    identityState: "stable",
    driverId: "driver:1",
    teamId: null,
    displayName: "Driver One",
    vehicleId: "car:1",
    pitState: "out",
    nativePitCode: 0,
    position: 1,
    speedMps: 30,
    fuelLitres: 40,
    tireCompound: "medium",
    tireWear: { fl: 0.2, fr: 0.2, rl: 0.2, rr: 0.2 },
    damage: { body: 0 },
    penaltyValue: 0,
    incidentCount: 0,
    retirementStatus: "active",
    nativeRetirementCode: null,
    ...overrides,
  };
}

export function observation(sequence: number, overrides: Partial<RaceEventObservation> = {}): RaceEventObservation {
  return {
    gameId: "iracing",
    sessionUid: "session:1",
    receivedAtMs: 1_700_000_000_000 + sequence,
    sourceTimeMs: sequence * 100,
    sourceSequences: [{ family: "iracing-session-tick", sequence }],
    lapNumber: 1,
    currentLapTimeMs: sequence * 100,
    lastLapTimeMs: 0,
    trackDistanceM: sequence * 10,
    trackDistancePct: Math.min(1, sequence / 100),
    worldPosition: null,
    sessionPhase: "unknown",
    nativeRaceControlCode: null,
    cautionKind: "unknown",
    gridStart: null,
    terminalObserved: null,
    participants: [participant()],
    rosterAuthoritative: false,
    ...overrides,
  };
}

export function lapEvaluation(overrides: Partial<RaceEventLapEvaluation> = {}): RaceEventLapEvaluation {
  return {
    lapNumber: 1,
    lapTimeMs: 90_000,
    isValid: true,
    phase: "flying",
    conditions: [],
    invalidReason: null,
    sectors: null,
    position: null,
    participantId: null,
    rawBoundaryOffset: null,
    rawBoundaryOrdinal: null,
    ...overrides,
  };
}
