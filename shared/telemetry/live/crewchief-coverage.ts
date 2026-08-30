import { TELEMETRY_CATALOG } from "../catalog/data";
import type { GameId } from "../../games/ids";
import type { TelemetryVariableId } from "../catalog/generated/telemetry-catalog.types";
import {
  CREWCHIEF_AUTOMATIC_EVENTS,
  CREWCHIEF_CALLOUT_SEMANTIC_IDS,
  CREWCHIEF_EVENT_GROUPS,
  CREWCHIEF_EVENT_SOURCES,
  CREWCHIEF_SEMANTIC_GROUPS,
  type CrewChiefCoverageState,
  type RaceIQSourceRef,
} from "./crewchief-callout-contract";

const groupIds = new Set(Object.keys(CREWCHIEF_SEMANTIC_GROUPS));
if (CREWCHIEF_AUTOMATIC_EVENTS.length !== 24 || Object.keys(CREWCHIEF_EVENT_GROUPS).length !== 25) throw new Error("CrewChief event contract must contain 24 automatic events plus Spotter");
for (const groups of Object.values(CREWCHIEF_EVENT_GROUPS)) for (const group of groups) if (!groupIds.has(group)) throw new Error(`Unknown CrewChief semantic group ${group}`);

const mappedSources = (gameId: GameId, semanticId: string): readonly RaceIQSourceRef[] => {
  const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.id === semanticId);
  const mapping = variable?.games[gameId];
  if (!mapping || mapping.kind === "unavailable") return [];
  const sources = Array.isArray(mapping.sources) ? mapping.sources : Object.values(mapping.sources).flat();
  return sources.map((source) => ({ path: "shared/telemetry/catalog/generated/telemetry-catalog.generated.ts", symbols: [source] }));
};
const ids = (...groups: readonly (keyof typeof CREWCHIEF_SEMANTIC_GROUPS)[]) => [...new Set(groups.flatMap((group) => CREWCHIEF_SEMANTIC_GROUPS[group]))] as TelemetryVariableId[];
const opponentIds = new Set(ids("OPPONENT"));
const spatialOpponentIds = new Set(ids("SPATIAL_SPOTTER").filter((id) => id.startsWith("motion.competitor.") || id === "race.competitor.connected" || id === "race.competitor.pit-status"));
const accBroadcastMapped = new Set(["race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name", "race.competitor.car-class-id", "race.competitor.car-class-name", "race.competitor.laps-complete", "race.competitor.pit-status", "race.competitor.track-location", "timing.competitor.last-lap-time", "timing.competitor.last-lap-valid", "motion.competitor.position-x", "motion.competitor.position-y", "motion.competitor.position-z", "motion.competitor.speed"]);
const iracingUnavailable = new Set(["timing.competitor.last-lap-valid", ...spatialOpponentIds]);
const f1Unavailable = new Set(ids("DRIVER_TEAM_RATINGS"));
const accUnavailable = new Set([...opponentIds, ...spatialOpponentIds].filter((id) => !accBroadcastMapped.has(id)));
const acEvoUnavailable = new Set([...opponentIds, ...spatialOpponentIds].filter((id) => !id.startsWith("motion.competitor.position-")));
const exception = (reasonCode: string, reason: string, event: string): CrewChiefCoverageState => ({ kind: "source-unavailable", reasonCode, reason, crewChiefSources: CREWCHIEF_EVENT_SOURCES[event] ?? [] });
function state(gameId: GameId, semanticId: TelemetryVariableId): CrewChiefCoverageState {
  if (gameId === "fm-2023") return { kind: "not-applicable", reasonCode: "no-crewchief-adapter", reason: "Pinned CrewChief reference has no Forza Motorsport adapter.", crewChiefSources: [] };
  if (gameId === "acc" && accUnavailable.has(semanticId)) return exception("missing-real-acc-broadcast-feed", "RaceIQ has no real ACC Broadcasting SDK feed for opponent identity, timing, or competitor spatial data.", "Position");
  if (gameId === "ac-evo" && acEvoUnavailable.has(semanticId)) return exception("upstream-value-fabricated-or-tbd", "Pinned AC Evo source labels opponent identity, timing, connectivity, and speed as semi-fake or TBD.", "Position");
  if (gameId === "iracing" && iracingUnavailable.has(semanticId)) return exception("source-unavailable", semanticId === "timing.competitor.last-lap-valid" ? "iRacing exposes no native competitor last-lap-valid field; conservative inference is intentionally not a resolver mapping." : "World competitor vectors are not projected into the iRacing semantic packet.", "Position");
  if (gameId === "f1-2025" && f1Unavailable.has(semanticId)) return exception("source-unavailable", "F1 25 UDP does not expose CrewChief repair, rating, licence, or driver-change fields used by this semantic group.", "Position");
  const raceIqSources = mappedSources(gameId, semanticId);
  if (!raceIqSources.length) return exception("missing-executable-catalog-link", "No executable parser-backed catalog link exists for this semantic value.", "Position");
  return { kind: "mapped", semanticId, parity: gameId === "f1-2025" ? "source-equivalent" : "crew-chief-native", crewChiefSources: CREWCHIEF_EVENT_SOURCES.Position ?? [], raceIqSources };
}
export const CREWCHIEF_COVERAGE = Object.freeze(Object.fromEntries((Object.keys(TELEMETRY_CATALOG.sources) as GameId[]).map((gameId) => [gameId, Object.fromEntries(CREWCHIEF_CALLOUT_SEMANTIC_IDS.map((semanticId) => [semanticId, state(gameId, semanticId)]))]))) as Record<GameId, Record<string, CrewChiefCoverageState>>;
