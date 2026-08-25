import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import {
  CREWCHIEF_AUTOMATIC_EVENTS,
  CREWCHIEF_CALLOUT_SEMANTIC_IDS,
  CREWCHIEF_EVENT_SOURCES,
  CREWCHIEF_REFERENCE,
  CREWCHIEF_SEMANTIC_GROUPS,
  type CrewChiefCoverageState,
  type RaceIQSourceRef,
} from "../../shared/telemetry/live/crewchief-callout-contract";

export { CREWCHIEF_REFERENCE, CREWCHIEF_AUTOMATIC_EVENTS, CREWCHIEF_SEMANTIC_GROUPS };

export const CREWCHIEF_EVENT_GROUPS = {
  Spotter: ["SESSION_TIMING", "OPPONENT", "SPATIAL_SPOTTER", "PITS_STRATEGY"],
  Position: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  LapCounter: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "CONDITIONS"],
  Timings: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  LapTimes: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Opponents: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Penalties: ["SESSION_TIMING", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  PitStops: ["SESSION_TIMING", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES"],
  Fuel: ["SESSION_TIMING", "ENERGY", "PITS_STRATEGY", "CONDITIONS", "SPATIAL_SPOTTER"],
  Battery: ["SESSION_TIMING", "ENERGY", "PITS_STRATEGY", "CONDITIONS", "SPATIAL_SPOTTER"],
  WatchedOpponents: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Strategy: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES", "CONDITIONS", "OVERTAKING_AIDS", "SPATIAL_SPOTTER"],
  PushNow: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES", "CONDITIONS", "OVERTAKING_AIDS", "SPATIAL_SPOTTER"],
  RaceTime: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY"],
  TyreMonitor: ["SESSION_TIMING", "TYRES_BRAKES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  EngineMonitor: ["SESSION_TIMING", "DAMAGE_ENGINE", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  DamageReporting: ["SESSION_TIMING", "DAMAGE_ENGINE", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  FlagsMonitor: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  ConditionsMonitor: ["SESSION_TIMING", "CONDITIONS"],
  OvertakingAidsMonitor: ["SESSION_TIMING", "OPPONENT", "PITS_STRATEGY", "OVERTAKING_AIDS"],
  FrozenOrderMonitor: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  Ratings: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "DRIVER_TEAM_RATINGS"],
  MulticlassWarnings: ["SESSION_TIMING", "OPPONENT", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  DriverSwaps: ["SESSION_TIMING", "PITS_STRATEGY", "DRIVER_TEAM_RATINGS"],
  SessionEndMessages: ["SESSION_TIMING"],
} as const;

const groupIds = new Set(Object.keys(CREWCHIEF_SEMANTIC_GROUPS));
if (CREWCHIEF_AUTOMATIC_EVENTS.length !== 24 || Object.keys(CREWCHIEF_EVENT_GROUPS).length !== 25) {
  throw new Error("CrewChief event contract must contain 24 automatic events plus Spotter");
}
for (const groups of Object.values(CREWCHIEF_EVENT_GROUPS)) {
  for (const group of groups) if (!groupIds.has(group)) throw new Error(`Unknown CrewChief semantic group ${group}`);
}

const mappedSources = (gameId: GameId, semanticId: string): readonly RaceIQSourceRef[] => {
  const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.id === semanticId);
  const mapping = variable?.games[gameId];
  if (!mapping || mapping.kind === "unavailable") return [];
  const sources = Array.isArray(mapping.sources) ? mapping.sources : Object.values(mapping.sources).flat();
  return sources.map((source) => ({ path: "shared/telemetry/catalog/generated/telemetry-catalog.generated.ts", symbols: [source] }));
};

const ids = (...groups: readonly (keyof typeof CREWCHIEF_SEMANTIC_GROUPS)[]) =>
  [...new Set(groups.flatMap((group) => CREWCHIEF_SEMANTIC_GROUPS[group]))] as TelemetryVariableId[];
const opponentIds = new Set(ids("OPPONENT"));
const spatialOpponentIds = new Set(ids("SPATIAL_SPOTTER").filter((id) => id.startsWith("motion.competitor.") || id === "race.competitor.connected" || id === "race.competitor.pit-status"));
const accBroadcastMapped = new Set([
  "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name", "race.competitor.car-class-id", "race.competitor.car-class-name",
  "race.competitor.laps-complete", "race.competitor.pit-status", "race.competitor.track-location", "timing.competitor.last-lap-time", "timing.competitor.last-lap-valid",
  "motion.competitor.position-x", "motion.competitor.position-y", "motion.competitor.position-z", "motion.competitor.speed",
]);
const iracingUnavailable = new Set(["timing.competitor.last-lap-valid", ...spatialOpponentIds]);
const f1Unavailable = new Set(ids("DRIVER_TEAM_RATINGS"));
const accUnavailable = new Set([...opponentIds, ...spatialOpponentIds].filter((id) => !accBroadcastMapped.has(id)));
const acEvoUnavailable = new Set([...opponentIds, ...spatialOpponentIds].filter((id) => !id.startsWith("motion.competitor.position-")));
const exception = (reasonCode: string, reason: string, event: string): CrewChiefCoverageState => ({
  kind: "source-unavailable",
  reasonCode,
  reason,
  crewChiefSources: CREWCHIEF_EVENT_SOURCES[event] ?? [],
});

function state(gameId: GameId, semanticId: TelemetryVariableId): CrewChiefCoverageState {
  const event = "Position";
  if (gameId === "fm-2023") return { kind: "not-applicable", reasonCode: "no-crewchief-adapter", reason: "Pinned CrewChief reference has no Forza Motorsport adapter.", crewChiefSources: [] };
  if (gameId === "acc" && accUnavailable.has(semanticId)) return exception("missing-real-acc-broadcast-feed", "RaceIQ has no real ACC Broadcasting SDK feed for opponent identity, timing, or competitor spatial data.", event);
  if (gameId === "ac-evo" && acEvoUnavailable.has(semanticId)) return exception("upstream-value-fabricated-or-tbd", "Pinned AC Evo source labels opponent identity, timing, connectivity, and speed as semi-fake or TBD.", event);
  if (gameId === "iracing" && iracingUnavailable.has(semanticId)) return exception("source-unavailable", semanticId === "timing.competitor.last-lap-valid" ? "iRacing exposes no native competitor last-lap-valid field; conservative inference is intentionally not a resolver mapping." : "World competitor vectors are not projected into the iRacing semantic packet.", event);
  if (gameId === "f1-2025" && f1Unavailable.has(semanticId)) return exception("source-unavailable", "F1 25 UDP does not expose CrewChief repair, rating, licence, or driver-change fields used by this semantic group.", event);
  const raceIqSources = mappedSources(gameId, semanticId);
  if (raceIqSources.length === 0) return exception("missing-executable-catalog-link", "No executable parser-backed catalog link exists for this semantic value.", event);
  return {
    kind: "mapped",
    semanticId: semanticId as never,
    parity: gameId === "f1-2025" ? "source-equivalent" : "crew-chief-native",
    crewChiefSources: CREWCHIEF_EVENT_SOURCES[event] ?? [],
    raceIqSources,
  };
}

export const CREWCHIEF_COVERAGE = Object.freeze(
  Object.fromEntries((Object.keys(TELEMETRY_CATALOG.sources) as GameId[]).map((gameId) => [
    gameId,
    Object.fromEntries(CREWCHIEF_CALLOUT_SEMANTIC_IDS.map((semanticId) => [semanticId, state(gameId, semanticId)])),
  ])),
) as Record<GameId, Record<string, CrewChiefCoverageState>>;

for (const gameId of Object.keys(CREWCHIEF_COVERAGE) as GameId[]) {
  for (const semanticId of CREWCHIEF_CALLOUT_SEMANTIC_IDS) {
    if (!CREWCHIEF_COVERAGE[gameId][semanticId]) throw new Error(`Missing CrewChief coverage ${gameId}:${semanticId}`);
  }
}
