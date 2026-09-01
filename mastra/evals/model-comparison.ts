import type { GameId } from "../../shared/games/ids";
import type { UnitSystem, TemperatureUnit } from "../../server/lap-analysis/report";
import { analystScorers, compareScorers, SCORER_THRESHOLDS, type ScoreResult } from "./index";
import type { ModelEvalCase } from "../../scripts/quality/model-eval-cases";

export type { ModelEvalCase, ScoreResult };

export interface ModelEvalObservation {
  modelId: string; caseId: string; agent: ModelEvalCase["agent"]; repeat: number;
  latencyMs: number; output: string; scores: ScoreResult[];
}
export interface ModelEvalFailure {
  modelId: string; caseId: string; repeat: number;
  stage: "generation" | "scoring"; message: string; latencyMs?: number; output?: string;
}
export interface ScorerSummary { id: string; mean: number; standardDeviation: number; passed: number; total: number; }
export interface ModelSummary {
  modelId: string; complete: boolean; overallScore: number | null; analystScore: number | null;
  compareScore: number | null; passRate: number | null; meanLatencyMs: number | null; scorers: ScorerSummary[];
}
export interface ModelEvalDataset {
  id: string; label: string; fixturePath: string; gameId: GameId; units: UnitSystem;
  temperatureUnit: TemperatureUnit; analystLap: number; compareLaps: readonly [number, number];
}
export interface ModelComparisonReport {
  schemaVersion: 1; createdAt: string; endpoint: string; repeatCount: number;
  modelIds: readonly string[]; dataset: ModelEvalDataset; caseIds: readonly string[];
  observations: readonly ModelEvalObservation[]; failures: readonly ModelEvalFailure[];
  summaries: readonly ModelSummary[]; ranking: string[]; recommendationIds: string[];
}

function family(agent: ModelEvalCase["agent"]) { return agent === "lap-analyst" ? analystScorers : compareScorers; }
function mean(values: readonly number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function scorerSummaries(observations: readonly ModelEvalObservation[], agent: ModelEvalCase["agent"]): ScorerSummary[] {
  return family(agent).map((scorer) => {
    const values = observations.filter((o) => o.agent === agent).flatMap((o) => o.scores.filter((s) => s.id === scorer.id).map((s) => s.score));
    const avg = mean(values) ?? 0;
    const sd = values.length ? Math.sqrt(values.reduce((sum, x) => sum + (x - avg) ** 2, 0) / values.length) : 0;
    const threshold = SCORER_THRESHOLDS[scorer.id] ?? 0.5;
    return { id: scorer.id, mean: avg, standardDeviation: sd, passed: values.filter((x) => x >= threshold).length, total: values.length };
  });
}
function applicableScores(observations: readonly ModelEvalObservation[]) {
  return observations.flatMap((o) => {
    const scorerIds: ReadonlySet<string> = new Set(family(o.agent).map((scorer) => scorer.id));
    return o.scores.filter((s) => typeof s.id === "string" && scorerIds.has(s.id));
  });
}

export function summariseModelResults(modelId: string, observations: readonly ModelEvalObservation[], failures: readonly ModelEvalFailure[], expectedCaseIds: readonly string[], repeatCount: number): ModelSummary {
  const expected = new Set(expectedCaseIds.flatMap((id) => Array.from({ length: repeatCount }, (_, i) => `${id}\u0000${i + 1}`)));
  const actual = observations.map((o) => `${o.caseId}\u0000${o.repeat}`);
  const complete = failures.length === 0 && actual.length === expected.size && new Set(actual).size === actual.length && actual.every((key) => expected.has(key));
  const familyScore = (agent: ModelEvalCase["agent"]) => mean(applicableScores(observations.filter((o) => o.agent === agent)).map((s) => s.score));
  const analystScore = familyScore("lap-analyst");
  const compareScore = familyScore("compare-engineer");
  const allScores = applicableScores(observations);
  const passRate = allScores.length ? allScores.filter((s) => s.score >= (SCORER_THRESHOLDS[s.id] ?? 0.5)).length / allScores.length : null;
  const latencies = [...observations.map((o) => o.latencyMs), ...failures.filter((f) => f.stage === "scoring" && f.latencyMs !== undefined).map((f) => f.latencyMs!)].filter((x) => Number.isFinite(x));
  return { modelId, complete, overallScore: analystScore !== null && compareScore !== null ? (analystScore + compareScore) / 2 : null, analystScore, compareScore, passRate, meanLatencyMs: mean(latencies), scorers: [...scorerSummaries(observations, "lap-analyst"), ...scorerSummaries(observations, "compare-engineer")] };
}

export function rankModelSummaries(summaries: readonly ModelSummary[]): { ranking: string[]; recommendationIds: string[] } {
  const complete = summaries.filter((s) => s.complete && s.overallScore !== null);
  const ranking = [...summaries].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    if (a.overallScore === null || b.overallScore === null) return a.overallScore === null ? (b.overallScore === null ? a.modelId.localeCompare(b.modelId) : 1) : -1;
    return b.overallScore - a.overallScore || (b.passRate ?? -1) - (a.passRate ?? -1) || a.modelId.localeCompare(b.modelId);
  }).map((s) => s.modelId);
  if (!complete.length) return { ranking, recommendationIds: [] };
  const best = [...complete].sort((a, b) => b.overallScore! - a.overallScore! || (b.passRate ?? -1) - (a.passRate ?? -1) || a.modelId.localeCompare(b.modelId))[0].overallScore!;
  return { ranking, recommendationIds: complete.filter((s) => best - s.overallScore! < 0.01).map((s) => s.modelId) };
}

export function buildModelComparisonReport(input: Omit<ModelComparisonReport, "schemaVersion" | "summaries" | "ranking" | "recommendationIds">): ModelComparisonReport {
  const summaries = input.modelIds.map((id) => summariseModelResults(id, input.observations.filter((o) => o.modelId === id), input.failures.filter((f) => f.modelId === id), input.caseIds, input.repeatCount));
  const ranked = rankModelSummaries(summaries);
  return { ...input, schemaVersion: 1, summaries, ...ranked };
}

const score = (x: number | null) => x === null ? "N/A" : x.toFixed(3);
const pct = (x: number | null) => x === null ? "N/A" : `${(x * 100).toFixed(1)}%`;
const latency = (x: number | null) => x === null ? "N/A" : `${Math.round(x)} ms`;
export function renderModelComparisonMarkdown(report: ModelComparisonReport): string {
  const { dataset } = report;
  const lines = [`# OSS Model Evaluation`, `Dataset: ${dataset.label} — analyst lap ${dataset.analystLap}; compare lap ${dataset.compareLaps[0]} vs lap ${dataset.compareLaps[1]}`, `Recommendation applies to this dataset only.`, "", "| Rank | Model | Overall | Analyst | Compare | Pass rate | Mean latency | Recommendation |", "|---:|---|---:|---:|---:|---:|---:|---|"];
  const rankByModel = new Map(report.ranking.map((modelId, index) => [modelId, index + 1]));
  report.summaries.forEach((s) => lines.push(`| ${s.complete ? rankByModel.get(s.modelId) ?? "N/A" : "N/A"} | ${s.modelId} | ${score(s.overallScore)} | ${score(s.analystScore)} | ${score(s.compareScore)} | ${pct(s.passRate)} | ${latency(s.meanLatencyMs)} | ${report.recommendationIds.includes(s.modelId) ? "recommended" : ""} |`));
  lines.push("", "| Model | Scorer | Mean | Population standard deviation | Passed | Total |", "|---|---|---:|---:|---:|---:|");
  for (const s of report.summaries) for (const sc of s.scorers) lines.push(`| ${s.modelId} | ${sc.id} | ${sc.mean.toFixed(3)} | ${sc.standardDeviation.toFixed(3)} | ${sc.passed} | ${sc.total} |`);
  lines.push("", "| Model | Case | Repeat | Stage | Message |", "|---|---|---:|---|---|");
  if (report.failures.length) for (const f of report.failures) lines.push(`| ${f.modelId} | ${f.caseId} | ${f.repeat} | ${f.stage} | ${f.message.replaceAll("|", "\\|")} |`);
  else lines.push("| — | — | — | — | No failures |");
  if (!report.recommendationIds.length) lines.push("", "No recommendation");
  return lines.join("\n") + "\n";
}
