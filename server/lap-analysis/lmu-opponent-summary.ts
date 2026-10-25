import { createHash } from "node:crypto";
import { encodeLmuResolvedValue, type LmuResolvedValueWire } from "@raceiq/shared/telemetry/lmu-context";
import type { LmuCompetitor } from "@raceiq/shared/telemetry/lmu";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import type { LmuOpponentLapInterval } from "./lmu-opponent-laps";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LmuOpponentPlayerLapFacts } from "./lmu-opponent-index-schema";

export interface LmuOpponentLapSummary {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapNumber: number | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  lapTime: LmuResolvedValueWire<number>;
  sectors: readonly { semanticId: string; duration: LmuResolvedValueWire<number> }[];
  comparableSemanticIds: readonly string[];
  mode: "timing-only" | "telemetry" | "unavailable";
  reasons: readonly LmuOpponentLapReason[];
}

export interface LmuOpponentSessionSummary {
  opponentSessionId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapIds: readonly string[];
}

export type LmuOpponentLapReason =
  | "partial-lap" | "invalid-lap" | "unknown-validity" | "restricted-channels"
  | "missing-timing" | "missing-distance" | "missing-position" | "no-comparable-data";

export interface LmuOpponentSummaryInput {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  lapNumber: number | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  endSequence: string | null;
  lastCompetitor: LmuCompetitor | null;
  opponentNumericChannelIds: readonly string[];
}

export interface LmuOpponentSummaryFacts extends Omit<LmuOpponentSummaryInput, "endSequence" | "lastCompetitor"> {
  driverName: string | null;
  carName: string | null;
  className: string | null;
  lapTime: LmuResolvedValueWire<number>;
  sectors: readonly { semanticId: string; duration: LmuResolvedValueWire<number> }[];
  opponentNumericChannelIds: readonly string[];
}

export interface LmuOpponentDomainSummary extends Omit<LmuOpponentLapSummary, "lapTime" | "sectors"> {
  lapTime: ResolvedValue<number>;
  sectors: readonly { semanticId: string; duration: ResolvedValue<number> }[];
}

const numeric = (value: ResolvedValue<unknown> | undefined): value is ResolvedValue<number> =>
  value?.state === "ok" && value.freshness === "fresh" &&
  typeof value.value === "number" && Number.isFinite(value.value);
export function createLmuOpponentPlayerLapFacts(
  playerLapId: number,
  packets: readonly TelemetryPacket[],
): LmuOpponentPlayerLapFacts {
  const comparableChannelIds = new Set<string>();
  for (const packet of packets) {
    const player = packet.lmuContext?.competitors?.find((competitor) => competitor.isPlayer);
    for (const [semanticId, value] of Object.entries(player?.channels ?? {})) {
      if (numeric(value)) comparableChannelIds.add(semanticId);
    }
  }
  return { playerLapId, comparableChannelIds: [...comparableChannelIds].sort() };
}

function baseSummary(input: LmuOpponentSummaryInput) {
  const competitor = input.lastCompetitor;
  const value = (semanticId: string) => competitor?.channels[semanticId]?.value ?? null;
  const resolved = (semanticId: string) => {
    const channel = competitor?.channels[semanticId];
    return numeric(channel) ? channel : null;
  };
  const missing = (semanticId: string): ResolvedValue<number> => {
    const source = Object.values(competitor?.channels ?? {})[0];
    if (!source) throw new Error("Opponent frame has no semantic source metadata");
    const { sourceChannel: _sourceChannel, ...provenance } = source.provenance;
    return {
      ...source, semanticId, value: null, unit: "s", mappingStatus: "unavailable", state: "missing",
      confidence: null, freshness: "unknown",
      confidenceComponents: { semanticFidelity: 0, freshness: null, inputCompleteness: 0 },
      provenance, limitations: [...source.limitations, "No source-backed timing report for this opponent interval."],
    };
  };
  const completed = input.endSequence !== null;
  const lapTime = (completed ? resolved("race.competitor.last-lap-time") : null) ?? missing("race.competitor.last-lap-time");
  const timing = completed ? resolved("race.competitor.last-sector-1") : null;
  const cumulative = completed ? resolved("race.competitor.last-sector-2-cumulative") : null;
  const sectors = [
    ...(timing ? [{ semanticId: "timing.sector.last-lap.s1", duration: timing }] : []),
    ...(timing && cumulative ? [{
      semanticId: "timing.sector.last-lap.s2",
      duration: {
        ...cumulative, value: cumulative.value! - timing.value!, mappingStatus: "derived" as const,
        provenance: { ...cumulative.provenance, derivation: { id: "lmu.opponent-sector-two.duration", version: "1", codeHash: createHash("sha256").update("cumulative-sector-1-2-minus-sector-1").digest("hex") } },
        limitations: [...cumulative.limitations, "Derived from cumulative sectors 1-2 minus sector 1."],
      },
    }] : []),
  ];
  const driverName = value("identity.competitor.driver-name");
  const carName = value("identity.competitor.car-name");
  const className = value("identity.competitor.vehicle-class");
  return {
    opponentLapId: input.opponentLapId, sessionKey: input.sessionKey, vehicleId: input.vehicleId,
    incarnation: input.incarnation, driverName: typeof driverName === "string" ? driverName : null,
    carName: typeof carName === "string" ? carName : null, className: typeof className === "string" ? className : null,
    lapNumber: input.lapNumber, coverage: input.coverage, validity: input.validity, endSequence: input.endSequence,
    lapTime, sectors,
    opponentNumericChannelIds: [...new Set(input.opponentNumericChannelIds)],
  };
}

function comparableFields(
  facts: Pick<LmuOpponentSummaryFacts, "opponentLapId" | "sessionKey" | "vehicleId" | "incarnation" | "driverName" | "carName" | "className" | "lapNumber" | "coverage" | "validity" | "lapTime" | "sectors" | "opponentNumericChannelIds">,
  playerChannels: ReadonlySet<string>,
) {
  const paired = (semanticId: string) => playerChannels.has(semanticId) && facts.opponentNumericChannelIds.includes(semanticId);
  const positionTrace = paired("motion.competitor.position.x") && paired("motion.competitor.position.z") &&
    paired("race.competitor.lap-distance");
  const comparableSemanticIds = [
    ...(facts.lapTime.state === "ok" ? ["timing.lap-time"] : []),
    ...(positionTrace ? ["motion.position-x", "motion.position-z"] : []),
    ...(paired("motion.competitor.speed") ? ["motion.speed"] : []),
    ...(paired("race.competitor.scoring-time") && paired("race.competitor.lap-start-time")
      ? ["race.competitor.scoring-time", "race.competitor.lap-start-time"] : []),
  ];
  return {
    opponentLapId: facts.opponentLapId, sessionKey: facts.sessionKey, vehicleId: facts.vehicleId,
    incarnation: facts.incarnation, driverName: facts.driverName, carName: facts.carName, className: facts.className,
    lapNumber: facts.lapNumber, coverage: facts.coverage, validity: facts.validity,
    lapTime: facts.lapTime, sectors: facts.sectors, comparableSemanticIds,
    mode: positionTrace ? "telemetry" as const : facts.lapTime.state === "ok" ? "timing-only" as const : "unavailable" as const,
    reasons: [
      ...(facts.coverage === "partial" ? ["partial-lap" as const] : []),
      ...(facts.validity === "unknown" ? ["unknown-validity" as const] : facts.validity === "invalid" ? ["invalid-lap" as const] : []),
      "restricted-channels" as const,
      ...(positionTrace || facts.lapTime.state === "ok" ? [] : ["missing-timing" as const, "no-comparable-data" as const]),
    ],
  };
}

export function createLmuOpponentSummaryFacts(input: LmuOpponentSummaryInput): LmuOpponentSummaryFacts {
  const base = baseSummary(input);
  return {
    opponentLapId: base.opponentLapId, sessionKey: base.sessionKey, vehicleId: base.vehicleId,
    incarnation: base.incarnation, driverName: base.driverName, carName: base.carName, className: base.className,
    lapNumber: base.lapNumber, coverage: base.coverage, validity: base.validity,
    lapTime: encodeLmuResolvedValue(base.lapTime),
    sectors: base.sectors.map((sector) => ({ ...sector, duration: encodeLmuResolvedValue(sector.duration) })),
    opponentNumericChannelIds: base.opponentNumericChannelIds,
  };
}

export function summarizeLmuOpponentSummaryFacts(
  facts: LmuOpponentSummaryFacts,
  playerComparableChannelIds: Iterable<string>,
): LmuOpponentLapSummary {
  const fields = comparableFields(facts, playerComparableChannelIds instanceof Set
    ? playerComparableChannelIds : new Set(playerComparableChannelIds));
  return fields;
}

export function summarizeLmuOpponentInterval(
  interval: LmuOpponentLapInterval,
  playerComparableChannelIds: Iterable<string> = [],
): LmuOpponentDomainSummary {
  const lastFrame = interval.frames.at(-1);
  const lastCompetitor = lastFrame?.competitors.find((entry) =>
    entry.vehicleId === interval.vehicleId && entry.incarnation === interval.incarnation) ?? null;
  const opponentNumericChannelIds = new Set<string>();
  for (const frame of interval.frames) {
    const competitor = frame.competitors.find((entry) =>
      entry.vehicleId === interval.vehicleId && entry.incarnation === interval.incarnation);
    for (const [semanticId, channel] of Object.entries(competitor?.channels ?? {})) {
      if (numeric(channel)) opponentNumericChannelIds.add(semanticId);
    }
  }
  const base = baseSummary({
    opponentLapId: interval.opponentLapId, sessionKey: interval.sessionKey, vehicleId: interval.vehicleId,
    incarnation: interval.incarnation, lapNumber: interval.lapNumber, coverage: interval.coverage,
    validity: interval.validity, endSequence: interval.endSequence, lastCompetitor,
    opponentNumericChannelIds: [...opponentNumericChannelIds],
  });
  const fields = comparableFields({ ...base, lapTime: encodeLmuResolvedValue(base.lapTime), sectors: base.sectors.map((sector) => ({ ...sector, duration: encodeLmuResolvedValue(sector.duration) })) },
    playerComparableChannelIds instanceof Set ? playerComparableChannelIds : new Set(playerComparableChannelIds));
  return { ...fields, lapTime: base.lapTime, sectors: base.sectors };
}

export function sortLmuOpponentSummaryFacts(facts: readonly LmuOpponentSummaryFacts[]): LmuOpponentSummaryFacts[] {
  return [...facts].sort((a, b) => (a.driverName ?? "").localeCompare(b.driverName ?? "") ||
    a.vehicleId - b.vehicleId || a.incarnation - b.incarnation || (a.lapNumber ?? 0) - (b.lapNumber ?? 0) ||
    a.opponentLapId.localeCompare(b.opponentLapId));
}

export function sortLmuOpponentLapSummaries(laps: readonly LmuOpponentLapSummary[]): LmuOpponentLapSummary[] {
  return [...laps].sort((a, b) => (a.driverName ?? "").localeCompare(b.driverName ?? "") ||
    a.vehicleId - b.vehicleId || a.incarnation - b.incarnation || (a.lapNumber ?? 0) - (b.lapNumber ?? 0) ||
    a.opponentLapId.localeCompare(b.opponentLapId));
}

export function groupLmuOpponentSessions(laps: readonly LmuOpponentLapSummary[]): LmuOpponentSessionSummary[] {
  const sessionsByIdentity = new Map<string, {
    summary: Omit<LmuOpponentSessionSummary, "lapIds">;
    laps: LmuOpponentLapSummary[];
  }>();
  for (const lap of laps) {
    const identity = JSON.stringify([lap.sessionKey, lap.vehicleId, lap.incarnation]);
    let session = sessionsByIdentity.get(identity);
    if (!session) {
      session = {
        summary: {
          opponentSessionId: createHash("sha256").update(identity).digest("hex"),
          sessionKey: lap.sessionKey, vehicleId: lap.vehicleId, incarnation: lap.incarnation,
          driverName: lap.driverName, carName: lap.carName, className: lap.className,
        },
        laps: [],
      };
      sessionsByIdentity.set(identity, session);
    }
    session.laps.push(lap);
  }
  return [...sessionsByIdentity.values()].map(({ summary, laps: sessionLaps }) => ({
    ...summary,
    lapIds: sessionLaps.sort((a, b) => (a.lapNumber ?? 0) - (b.lapNumber ?? 0) ||
      a.opponentLapId.localeCompare(b.opponentLapId)).map((lap) => lap.opponentLapId),
  })).sort((a, b) => (a.driverName ?? "").localeCompare(b.driverName ?? "") ||
    a.vehicleId - b.vehicleId || a.incarnation - b.incarnation || a.sessionKey.localeCompare(b.sessionKey) ||
    a.opponentSessionId.localeCompare(b.opponentSessionId));
}
