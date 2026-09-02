import type { GameId } from "../../shared/games/ids";
import type { UnitSystem, TemperatureUnit } from "../../server/lap-analysis/report";
import { analystScorers, compareScorers, SCORER_THRESHOLDS, type ScoreResult } from "./index";
import type { ModelEvalCase, ModelEvalTruth } from "../../scripts/quality/model-eval-cases";

export type { ModelEvalCase, ScoreResult };

export interface ModelEvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}
export interface ModelEvalObservation {
  modelId: string; caseId: string; agent: ModelEvalCase["agent"]; repeat: number;
  latencyMs: number; output: string; scores: ScoreResult[]; usage?: ModelEvalUsage;
}
export interface ModelEvalFailure {
  modelId: string; caseId: string; repeat: number;
  stage: "generation" | "scoring"; message: string; latencyMs?: number; output?: string;
  usage?: ModelEvalUsage;
}
export interface ScorerSummary { id: string; mean: number; standardDeviation: number; passed: number; total: number; }
export interface ModelSummary {
  modelId: string; complete: boolean; overallScore: number | null; analystScore: number | null;
  compareScore: number | null; correctnessScore: number | null; passRate: number | null; meanLatencyMs: number | null;
  meanInputTokens: number | null; meanOutputTokens: number | null;
  meanReasoningTokens: number | null; meanTotalTokens: number | null;
  meanTokensPerSecond: number | null; scorers: ScorerSummary[];
}
export interface ModelEvalDataset {
  id: string; label: string; fixturePath: string; gameId: GameId; units: UnitSystem;
  temperatureUnit: TemperatureUnit; analystLap: number; compareLaps: readonly [number, number];
}
export interface ModelComparisonReport {
  schemaVersion: 1; createdAt: string; endpoint: string; repeatCount: number;
  judgeModel?: string;
  modelIds: readonly string[]; dataset: ModelEvalDataset; caseIds: readonly string[];
  truth?: Readonly<Record<string, ModelEvalTruth>>;
  observations: readonly ModelEvalObservation[]; failures: readonly ModelEvalFailure[];
  summaries: readonly ModelSummary[]; ranking: string[]; recommendationIds: string[];
}

function family(agent: ModelEvalCase["agent"]) { return agent === "lap-analyst" ? analystScorers : compareScorers; }
function mean(values: readonly number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function scorerSummaries(observations: readonly ModelEvalObservation[], agent: ModelEvalCase["agent"]): ScorerSummary[] {
  const ids = [...family(agent).map((scorer) => scorer.id), ...(observations.some((o) => o.scores.some((s) => s.id === "correctness")) ? ["correctness"] : [])];
  return ids.map((id) => {
    const values = observations.filter((o) => o.agent === agent).flatMap((o) => o.scores.filter((s) => s.id === id).map((s) => s.score));
    const avg = mean(values) ?? 0;
    const sd = values.length ? Math.sqrt(values.reduce((sum, x) => sum + (x - avg) ** 2, 0) / values.length) : 0;
    const threshold = SCORER_THRESHOLDS[id] ?? 0.5;
    return { id, mean: avg, standardDeviation: sd, passed: values.filter((x) => x >= threshold).length, total: values.length };
  });
}
function applicableScores(observations: readonly ModelEvalObservation[]) {
  return observations.flatMap((o) => {
    const scorerIds: ReadonlySet<string> = new Set([...family(o.agent).map((scorer) => scorer.id), "correctness"]);
    return o.scores.filter((s) => typeof s.id === "string" && scorerIds.has(s.id));
  });
}
function usageValues(observations: readonly ModelEvalObservation[], failures: readonly ModelEvalFailure[], key: keyof ModelEvalUsage) {
  return [...observations.map((o) => o.usage?.[key]), ...failures.filter((f) => f.stage === "scoring").map((f) => f.usage?.[key])].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}
function throughputValues(observations: readonly ModelEvalObservation[], failures: readonly ModelEvalFailure[]) {
  return [...observations.map((o) => ({ usage: o.usage, latencyMs: o.latencyMs })), ...failures.filter((f) => f.stage === "scoring").map((f) => ({ usage: f.usage, latencyMs: f.latencyMs }))].map(({ usage, latencyMs }) => {
    const tokens = (usage?.outputTokens ?? 0) + (usage?.reasoningTokens ?? 0);
    return typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs > 0 && Number.isFinite(tokens) && tokens > 0 ? tokens / (latencyMs / 1000) : undefined;
  }).filter((x): x is number => x !== undefined);
}
export function summariseModelResults(modelId: string, observations: readonly ModelEvalObservation[], failures: readonly ModelEvalFailure[], expectedCaseIds: readonly string[], repeatCount: number): ModelSummary {
  const expected = new Set(expectedCaseIds.flatMap((id) => Array.from({ length: repeatCount }, (_, i) => `${id}\u0000${i + 1}`)));
  const actual = observations.map((o) => `${o.caseId}\u0000${o.repeat}`);
  const complete = failures.length === 0 && actual.length === expected.size && new Set(actual).size === actual.length && actual.every((key) => expected.has(key));
  const familyScore = (agent: ModelEvalCase["agent"]) => mean(applicableScores(observations.filter((o) => o.agent === agent)).map((s) => s.score));
  const analystScore = familyScore("lap-analyst"), compareScore = familyScore("compare-engineer");
  const correctnessScore = mean(observations.flatMap((o) => o.scores.filter((s) => s.id === "correctness").map((s) => s.score)));
  const throughput = throughputValues(observations, failures);
  const allScores = applicableScores(observations);
  const passRate = allScores.length ? allScores.filter((s) => s.score >= (SCORER_THRESHOLDS[s.id] ?? 0.5)).length / allScores.length : null;
  const latencies = [...observations.map((o) => o.latencyMs), ...failures.filter((f) => f.stage === "scoring" && f.latencyMs !== undefined).map((f) => f.latencyMs!)].filter((x) => Number.isFinite(x));
  const avgUsage = (key: keyof ModelEvalUsage) => mean(usageValues(observations, failures, key));
  return { modelId, complete, overallScore: analystScore !== null && compareScore !== null ? (analystScore + compareScore) / 2 : null, analystScore, compareScore, correctnessScore, passRate, meanLatencyMs: mean(latencies), meanInputTokens: avgUsage("inputTokens"), meanOutputTokens: avgUsage("outputTokens"), meanReasoningTokens: avgUsage("reasoningTokens"), meanTotalTokens: avgUsage("totalTokens"), meanTokensPerSecond: mean(throughput), scorers: [...scorerSummaries(observations, "lap-analyst"), ...scorerSummaries(observations, "compare-engineer")] };
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
const score = (x: number | null | undefined) => x === null || x === undefined ? "N/A" : x.toFixed(3);
const pct = (x: number | null) => x === null ? "N/A" : `${(x * 100).toFixed(1)}%`;
const latency = (x: number | null) => x === null ? "N/A" : `${Math.round(x)} ms`;
const markdownCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const excerpt = (value: string, limit = 600) => {
  const compact = value.replaceAll("```", "'''").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
};
export function renderModelComparisonMarkdown(report: ModelComparisonReport): string {
  const { dataset } = report;
  const lines = [
    "# OSS Model Evaluation",
    "",
    "## Executive summary",
    `- Dataset: **${markdownCell(dataset.label)}** (${dataset.gameId}, ${dataset.units}; analyst lap ${dataset.analystLap}; compare laps ${dataset.compareLaps[0]} vs ${dataset.compareLaps[1]})`,
    `- Generated: \`${report.createdAt}\``,
    `- Endpoint: \`${report.endpoint}\``,
    `- Repeats: **${report.repeatCount} per case**`,
    `- Correctness judge: **${report.judgeModel ?? "disabled"}**`,
    `- Recommendation scope: this dataset and prompt contract only.`,
    "",
    "### Recommendation",
  ];
  if (report.recommendationIds.length) {
    lines.push(`**${report.recommendationIds.map(markdownCell).join("**, **")}**`);
  } else {
    lines.push("**No recommendation.** At least one complete model with a valid quality score is required.");
  }
  lines.push("", "## Authoritative telemetry truth", "Truth is generated from parsed packets and curated geometry, independent of model output. Full truth objects are embedded in the JSON artifact.", "");
  if (report.truth) {
    for (const [caseId, truth] of Object.entries(report.truth)) {
      const details = truth.metrics
        ? `lap ${truth.lapNumber ?? "N/A"} (${truth.lapTime?.toFixed(3) ?? "N/A"} s), ${truth.metrics.segmentStats.length} segments, slowest corners are fixture-derived`
        : `faster lap: ${truth.fasterLap ?? "N/A"}, ${truth.comparison?.cornerDeltas.length ?? 0} corner deltas`;
      lines.push(`- **${markdownCell(caseId)}** — ${details}`);
    }
  } else {
    lines.push("- Truth bundle unavailable in this artifact.");
  }
  lines.push(
    "",
    "## Model comparison",
    "",
    "Quality ranking uses macro average of Analyst and Compare scores. Latency and throughput are reported for diagnosis, not ranking.",
    "",
    "| Rank | Model | Status | Overall | Analyst | Compare | Correctness | Pass rate | Mean latency | Input tok | Output tok | Thinking tok | Total tok | tok/s |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  const rankByModel = new Map(report.ranking.map((modelId, index) => [modelId, index + 1]));
  for (const summary of report.summaries) {
    lines.push(`| ${summary.complete ? rankByModel.get(summary.modelId) ?? "N/A" : "N/A"} | ${markdownCell(summary.modelId)} | ${summary.complete ? "complete" : "incomplete"} | ${score(summary.overallScore)} | ${score(summary.analystScore)} | ${score(summary.compareScore)} | ${score(summary.correctnessScore)} | ${pct(summary.passRate)} | ${latency(summary.meanLatencyMs)} | ${score(summary.meanInputTokens)} | ${score(summary.meanOutputTokens)} | ${score(summary.meanReasoningTokens)} | ${score(summary.meanTotalTokens)} | ${score(summary.meanTokensPerSecond)} |`);
  }
  lines.push("", "## Scorer breakdown", "Each scorer is averaged across repeats. Reasons are retained below in case evidence.", "", "| Model | Scorer | Mean | Population SD | Passed | Total |", "|---|---|---:|---:|---:|---:|");
  for (const summary of report.summaries) for (const scorer of summary.scorers) lines.push(`| ${markdownCell(summary.modelId)} | ${scorer.id} | ${scorer.mean.toFixed(3)} | ${scorer.standardDeviation.toFixed(3)} | ${scorer.passed} | ${scorer.total} |`);
  lines.push("", "## Case evidence", "", "| Model | Case | Repeat | Scorer | Score | Reason |", "|---|---|---:|---|---:|---|");
  for (const observation of report.observations) for (const scorer of observation.scores) lines.push(`| ${markdownCell(observation.modelId)} | ${markdownCell(observation.caseId)} | ${observation.repeat} | ${scorer.id} | ${scorer.score.toFixed(3)} | ${markdownCell(scorer.reason)} |`);
  lines.push("", "## Output excerpts", "First successful output per model and case; complete raw outputs remain in the JSON artifact.", "");
  const seenOutputs = new Set<string>();
  for (const observation of report.observations) {
    const key = `${observation.modelId}\u0000${observation.caseId}`;
    if (seenOutputs.has(key)) continue;
    seenOutputs.add(key);
    lines.push(`### ${markdownCell(observation.modelId)} — ${markdownCell(observation.caseId)}`, "", "```text", excerpt(observation.output), "```", "");
  }
  lines.push("## Failures", "", "| Model | Case | Repeat | Stage | Message |", "|---|---|---:|---|---|");
  if (report.failures.length) for (const failure of report.failures) lines.push(`| ${markdownCell(failure.modelId)} | ${markdownCell(failure.caseId)} | ${failure.repeat} | ${failure.stage} | ${markdownCell(failure.message)} |`);
  else lines.push("| — | — | — | — | No failures |");
  return `${lines.join("\n")}\n`;
}
