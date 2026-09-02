import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Mastra } from "@mastra/core/mastra";
import type { Dataset } from "@mastra/core/datasets";
interface DatasetItemPayload { externalId: string; input: unknown; groundTruth?: unknown; metadata?: unknown; expectedTrajectory?: unknown; toolMocks?: unknown; unmockedToolPolicy?: unknown; [key: string]: unknown }
type DatasetItem = DatasetItemPayload & { id: string };
import type { ComparisonResult } from "../../server/lap-analysis/comparison";
import type { LapMetrics } from "../../server/lap-analysis/metrics";
import type { GameId } from "../../shared/games/ids";
import type { UnitSystem, TemperatureUnit } from "../../server/lap-analysis/report";
import { parseDump, type CapturedLapWithPackets } from "../../test/support/recordings/parse-dump";
import { resolveLapSegments, lapCornersFromSegments } from "../../server/tracks/corner-resolution";
import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";
import { buildInputsComparePrompt, type PromptSegment } from "../../server/ai/inputs-compare-prompt";
import { compareLaps } from "../../server/lap-analysis/comparison";
import { computeLapMetrics } from "../../server/lap-analysis/metrics";

export interface ModelEvalFixtureConfig { id: string; label: string; fixturePath: string; gameId: GameId; units: UnitSystem; temperatureUnit: TemperatureUnit; analystLapNumber: number; compareLapNumbers: readonly [number, number]; }
export interface ModelEvalTruth { lapNumber?: number; lapTime?: number; metrics?: Pick<LapMetrics, "lapId" | "algoVersion" | "segmentStats">; comparison?: Pick<ComparisonResult, "cornerDeltas">; fasterLap?: "A" | "B"; }
export interface ModelEvalGroundTruth { trackCorners: string[]; slowestCorners?: string[]; fasterLap?: "A" | "B"; units: UnitSystem; sourceContext?: string; truth: ModelEvalTruth; agent: "lap-analyst" | "compare-engineer"; lapIds: readonly number[]; }
export interface ParsedModelEvalFixture { config: ModelEvalFixtureConfig; carOrdinal: number; trackOrdinal: number; analystLap: CapturedLapWithPackets; compareLaps: readonly [CapturedLapWithPackets, CapturedLapWithPackets]; }
export interface ModelEvalDatasetDefinition { id: string; name: string; targetId: "lap-analyst" | "compare-engineer"; scorerIds: readonly string[]; items: readonly DatasetItemPayload[]; }

export const ACC_MODEL_EVAL_CONFIG: ModelEvalFixtureConfig = { id: "acc-brands-hatch-2026-04-10", label: "ACC Brands Hatch fixture", fixturePath: "test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz", gameId: "acc", units: "metric", temperatureUnit: "C", analystLapNumber: 3, compareLapNumbers: [2, 3] };
export const MODEL_EVAL_FIXTURES: Readonly<Record<string, ModelEvalFixtureConfig>> = { [ACC_MODEL_EVAL_CONFIG.id]: ACC_MODEL_EVAL_CONFIG };

export async function loadParsedModelEvalFixture(config: ModelEvalFixtureConfig): Promise<ParsedModelEvalFixture> {
  const absolutePath = resolve(process.cwd(), config.fixturePath); if (!existsSync(absolutePath)) throw new Error(`Model eval fixture missing: ${absolutePath}`);
  const result = await parseDump(config.gameId, absolutePath); if (result.sessions.length !== 1 || result.sessions[0].gameId !== config.gameId) throw new Error(`Model eval fixture ${config.id} must contain one ${config.gameId} session`);
  const required = [config.analystLapNumber, ...config.compareLapNumbers]; const laps = required.map((n) => result.laps.find((lap) => lap.lapNumber === n && lap.isValid && lap.packets.length > 0));
  if (laps.some((lap) => !lap)) throw new Error(`Model eval fixture ${config.id} is missing required valid lap(s): ${required.join(", ")}`);
  const [analystLap, lapA, lapB] = laps as CapturedLapWithPackets[]; if (lapA.lapTime === lapB.lapTime) throw new Error(`Model eval fixture ${config.id} comparison laps must have different times`);
  const session = result.sessions[0]; return { config, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal, analystLap, compareLaps: [lapA, lapB] };
}

const canonical = (value: unknown): string => { const seen = new Set<object>(); const encode = (v: unknown): unknown => { if (typeof v === "number" && !Number.isFinite(v)) throw new Error("Dataset payload contains non-finite number"); if (v === undefined || typeof v === "function" || typeof v === "symbol") throw new Error("Dataset payload contains unsupported value"); if (v && typeof v === "object") { if (seen.has(v)) throw new Error("Dataset payload contains cycle"); seen.add(v); if (Array.isArray(v)) return v.map(encode); const out: Record<string, unknown> = {}; for (const key of Object.keys(v).sort()) out[key] = encode((v as Record<string, unknown>)[key]); seen.delete(v); return out; } return v; }; return JSON.stringify(encode(value)); };

export async function buildModelEvalDatasetDefinitions(fixture: ParsedModelEvalFixture, repeats = 3): Promise<readonly [ModelEvalDatasetDefinition, ModelEvalDatasetDefinition]> {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be positive");
  const { config, analystLap, compareLaps: [lapA, lapB], trackOrdinal, carOrdinal } = fixture; const segments = await resolveLapSegments(trackOrdinal, config.gameId); if (!segments.length) throw new Error(`Model eval fixture ${config.id} has no curated segments`);
  const corners = lapCornersFromSegments(segments, analystLap.packets); if (corners.length < 3) throw new Error(`Model eval fixture ${config.id} must resolve at least three corners`); const promptSegments = segments as PromptSegment[];
  const metrics = computeLapMetrics(0, analystLap.packets, config.gameId, segments); const cornerStats = metrics.segmentStats.filter((s) => s.type === "corner"); const trackCorners = cornerStats.map((s) => s.name); const slowestCorners = [...cornerStats].sort((a,b) => a.stats.minSpeed-b.stats.minSpeed || a.startFrac-b.startFrac).slice(0,3).map((s) => s.name); const comparison = compareLaps(lapA.packets, lapB.packets, corners);
  const lapId = (lap: CapturedLapWithPackets): number => lap.lapNumber;
  const lapIds = [lapId(analystLap), lapId(lapA), lapId(lapB)];
  if (lapIds.some((id) => !Number.isFinite(id) || id <= 0)) throw new Error(`Model eval fixture ${config.id} requires positive lap IDs`);
  if ([analystLap, lapA, lapB].some((lap) => !lap.packets.length || !lap.isValid)) throw new Error(`Model eval fixture ${config.id} has unusable telemetry`);
  const analystTruth: ModelEvalTruth = { lapNumber: analystLap.lapNumber, lapTime: analystLap.lapTime, metrics: { lapId: metrics.lapId, algoVersion: metrics.algoVersion, segmentStats: metrics.segmentStats } }; const compareTruth: ModelEvalTruth = { fasterLap: lapA.lapTime < lapB.lapTime ? "A" : "B", comparison: { cornerDeltas: comparison.cornerDeltas } };
  const analystInput = buildAnalystPrompt({ lapNumber: analystLap.lapNumber, lapTime: analystLap.lapTime, isValid: true, carOrdinal, trackOrdinal, gameId: config.gameId }, analystLap.packets, corners, config.units, config.temperatureUnit, undefined, promptSegments);
  const lapInfo = (lap: CapturedLapWithPackets) => ({ id: lapId(lap), lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, carOrdinal, trackOrdinal, gameId: config.gameId }); const compareInput = buildInputsComparePrompt(lapInfo(lapA), lapInfo(lapB), comparison, promptSegments);
  const context = (prompt: string, truth: ModelEvalTruth) => `${prompt}\n\nAUTHORITATIVE TELEMETRY TRUTH (use only for grading; model did not see this):\n${JSON.stringify(truth)}`;
  const make = (agent: ModelEvalGroundTruth["agent"], input: string, truth: ModelEvalTruth, lapIds: readonly number[], extra: Partial<DatasetItemPayload> = {}): DatasetItemPayload[] => Array.from({ length: repeats }, (_, i) => ({ externalId: `${config.id}-${agent === "lap-analyst" ? `lap-${config.analystLapNumber}-analyst` : `laps-${config.compareLapNumbers[0]}-vs-${config.compareLapNumbers[1]}-compare`}-repeat-${i+1}`, input, groundTruth: { trackCorners, ...(agent === "lap-analyst" ? { slowestCorners } : { fasterLap: truth.fasterLap }), units: config.units, sourceContext: context(input, truth), truth, agent, lapIds } satisfies ModelEvalGroundTruth, metadata: { fixtureId: config.id, caseId: `${config.id}-${agent}`, repeat: i+1, agent, gameId: config.gameId, units: config.units }, ...extra }));
  const mock = (lapId: number) => ({ toolName: "generate_lap_analysis", args: { lapId }, output: { available: false, lapId, readable: "Lap analysis generation is disabled in fixture-backed evaluation.", cached: false, error: "Fixture-backed evaluation is read-only" } });
  const analystItems = make("lap-analyst", analystInput, analystTruth, [lapId(analystLap)], { expectedTrajectory: { allowRepeatedSteps: false, noRedundantCalls: true, maxSteps: 4 }, blacklistedTools: ["generate_lap_analysis"] });
  const compareItems = make("compare-engineer", compareInput, compareTruth, [lapId(lapA), lapId(lapB)], { toolMocks: [mock(lapId(lapA)), mock(lapId(lapB))], unmockedToolPolicy: "allow", expectedTrajectory: { steps: [{ toolName: "get_lap_analysis", toolArgs: { lapId: lapId(lapA) } }, { toolName: "generate_lap_analysis", toolArgs: { lapId: lapId(lapA) } }, { toolName: "get_lap_analysis", toolArgs: { lapId: lapId(lapB) } }, { toolName: "generate_lap_analysis", toolArgs: { lapId: lapId(lapB) } }], allowRepeatedSteps: false, noRedundantCalls: true, maxSteps: 8 } });
  return [{ id: "raceiq-model-eval-lap-analyst", name: "RaceIQ model eval — lap analyst", targetId: "lap-analyst", scorerIds: ["code-trajectory-scorer", "check-no-tool-errors"], items: analystItems }, { id: "raceiq-model-eval-compare-engineer", name: "RaceIQ model eval — compare engineer", targetId: "compare-engineer", scorerIds: ["code-trajectory-scorer", "check-no-tool-errors"], items: compareItems }];
}

export async function syncModelEvalDataset(mastra: Mastra, definition: ModelEvalDatasetDefinition): Promise<{ dataset: Dataset; version: number }> {
  if (definition.items.some((item) => typeof item.externalId !== "string" || item.externalId.length === 0)) throw new Error(`Missing dataset external ID for ${definition.id}`);
  const payloadIds = new Set(definition.items.map((item) => item.externalId));
  if (payloadIds.size !== definition.items.length) throw new Error(`Duplicate dataset external IDs for ${definition.id}`);
  definition.items.forEach((item) => canonical(item));
  let dataset: Dataset | undefined; let page = 0; do { const listed = await mastra.datasets.list({ page, perPage: 100 }); const found = listed.datasets.find((d) => d.id === definition.id); if (found) { dataset = await mastra.datasets.get({ id: definition.id }); break; } page++; if (!listed.pagination.hasMore) break; } while (!dataset);
  if (!dataset) dataset = await mastra.datasets.create({ id: definition.id, name: definition.name, targetType: "agent", targetIds: [definition.targetId], scorerIds: [...definition.scorerIds] });
  const existing: DatasetItem[] = []; page = 0; let hasMore = true; while (hasMore) { const listed = await dataset.listItems({ page, perPage: 100 }); const items = (Array.isArray(listed) ? listed : listed.items) as unknown as DatasetItem[]; existing.push(...items); hasMore = !Array.isArray(listed) && listed.pagination.hasMore; page++; }
  const expected = new Map(definition.items.map((item) => [item.externalId, item])); if (expected.size !== definition.items.length) throw new Error(`Duplicate dataset external IDs for ${definition.id}`); definition.items.forEach((item) => canonical(item)); for (const item of existing) if (typeof item.externalId !== "string" || item.externalId.length === 0 || !expected.has(item.externalId) || existing.filter((candidate) => candidate.externalId === item.externalId).length > 1) throw new Error(`Unexpected stale or duplicate dataset item ${item.externalId ?? "<missing>"}`);
  for (const [externalId, payload] of expected) { const old = existing.find((item) => item.externalId === externalId); if (!old) await (dataset as unknown as { addItem: (item: unknown) => Promise<unknown> }).addItem(payload); else if (canonical(payload) !== canonical({ externalId: old.externalId, input: old.input, groundTruth: old.groundTruth, expectedTrajectory: old.expectedTrajectory, toolMocks: old.toolMocks, unmockedToolPolicy: old.unmockedToolPolicy, metadata: old.metadata })) await (dataset as unknown as { updateItem: (item: unknown) => Promise<unknown> }).updateItem({ itemId: old.id, ...payload }); }
  const versions = await dataset.listVersions({ page: 0, perPage: 1 }); return { dataset, version: versions.versions[0]?.version ?? 1 };
}
