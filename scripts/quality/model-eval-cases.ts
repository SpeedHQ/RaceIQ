import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GameId } from "../../shared/games/ids";
import type { UnitSystem, TemperatureUnit } from "../../server/lap-analysis/report";
import { parseDump, type CapturedLapWithPackets } from "../../test/support/recordings/parse-dump";
import { resolveLapSegments, lapCornersFromSegments } from "../../server/tracks/corner-resolution";
import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";
import { buildInputsComparePrompt, type PromptSegment } from "../../server/ai/inputs-compare-prompt";
import { compareLaps } from "../../server/lap-analysis/comparison";
import { computeLapMetrics } from "../../server/lap-analysis/metrics";

export interface ModelEvalFixtureConfig {
  id: string; label: string; fixturePath: string; gameId: GameId;
  units: UnitSystem; temperatureUnit: TemperatureUnit; analystLapNumber: number;
  compareLapNumbers: readonly [number, number];
}
export interface ModelEvalFixtureCase {
  id: string; agent: "lap-analyst" | "compare-engineer"; input: string;
  groundTruth: { trackCorners: string[]; slowestCorners?: string[]; fasterLap?: "A" | "B"; units: UnitSystem };
}
export type ModelEvalCase = ModelEvalFixtureCase;
export interface ParsedModelEvalFixture {
  config: ModelEvalFixtureConfig; carOrdinal: number; trackOrdinal: number;
  analystLap: CapturedLapWithPackets;
  compareLaps: readonly [CapturedLapWithPackets, CapturedLapWithPackets];
}

export const ACC_MODEL_EVAL_CONFIG: ModelEvalFixtureConfig = {
  id: "acc-brands-hatch-2026-04-10", label: "ACC Brands Hatch fixture",
  fixturePath: "test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz", gameId: "acc",
  units: "metric", temperatureUnit: "C", analystLapNumber: 3, compareLapNumbers: [2, 3],
};
export const MODEL_EVAL_FIXTURES: Readonly<Record<string, ModelEvalFixtureConfig>> = {
  [ACC_MODEL_EVAL_CONFIG.id]: ACC_MODEL_EVAL_CONFIG,
};

export async function loadParsedModelEvalFixture(config: ModelEvalFixtureConfig): Promise<ParsedModelEvalFixture> {
  const absolutePath = resolve(process.cwd(), config.fixturePath);
  if (!existsSync(absolutePath)) throw new Error(`Model eval fixture missing: ${absolutePath}`);
  const result = await parseDump(config.gameId, absolutePath);
  if (result.sessions.length !== 1 || result.sessions[0].gameId !== config.gameId) {
    throw new Error(`Model eval fixture ${config.id} must contain one ${config.gameId} session`);
  }
  const required = [config.analystLapNumber, ...config.compareLapNumbers];
  const laps = required.map((n) => result.laps.find((lap) => lap.lapNumber === n && lap.isValid && lap.packets.length > 0));
  if (laps.some((lap) => !lap)) throw new Error(`Model eval fixture ${config.id} is missing required valid lap(s): ${required.join(", ")}`);
  const [analystLap, lapA, lapB] = laps as CapturedLapWithPackets[];
  if (lapA.lapTime === lapB.lapTime) throw new Error(`Model eval fixture ${config.id} comparison laps must have different times`);
  const session = result.sessions[0];
  return { config, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal, analystLap, compareLaps: [lapA, lapB] };
}

export async function buildModelEvalCases(fixture: ParsedModelEvalFixture): Promise<ModelEvalCase[]> {
  const { config, analystLap, compareLaps: [lapA, lapB], trackOrdinal, carOrdinal } = fixture;
  const segments = await resolveLapSegments(trackOrdinal, config.gameId);
  if (segments.length === 0) throw new Error(`Model eval fixture ${config.id} has no curated segments`);
  const corners = lapCornersFromSegments(segments, analystLap.packets);
  if (corners.length < 3) throw new Error(`Model eval fixture ${config.id} must resolve at least three corners`);
  const promptSegments = segments as PromptSegment[];
  const metrics = computeLapMetrics(0, analystLap.packets, config.gameId, segments);
  const cornerStats = metrics.segmentStats.filter((s) => s.type === "corner");
  const slowestCorners = [...cornerStats].sort((a, b) => a.stats.minSpeed - b.stats.minSpeed || a.startFrac - b.startFrac).slice(0, 3).map((s) => s.name);
  const trackCorners = cornerStats.map((s) => s.name);
  const analyst = buildAnalystPrompt({ lapNumber: analystLap.lapNumber, lapTime: analystLap.lapTime, isValid: true, carOrdinal, trackOrdinal, gameId: config.gameId }, analystLap.packets, corners, config.units, config.temperatureUnit, undefined, promptSegments);
  const lapInfo = (lap: CapturedLapWithPackets) => ({ lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, carOrdinal, trackOrdinal, gameId: config.gameId });
  const comparison = compareLaps(lapA.packets, lapB.packets, corners);
  const compare = buildInputsComparePrompt(lapInfo(lapA), lapInfo(lapB), comparison, promptSegments);
  return [
    { id: `${config.id}-lap-${config.analystLapNumber}-analyst`, agent: "lap-analyst", input: analyst, groundTruth: { trackCorners, slowestCorners, units: config.units } },
    { id: `${config.id}-laps-${config.compareLapNumbers[0]}-vs-${config.compareLapNumbers[1]}-compare`, agent: "compare-engineer", input: compare, groundTruth: { trackCorners, fasterLap: lapA.lapTime < lapB.lapTime ? "A" : "B", units: config.units } },
  ];
}
