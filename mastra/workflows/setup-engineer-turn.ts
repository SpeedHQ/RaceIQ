/**
 * setup-engineer-turn — deterministic prerequisite gathering for the Setup
 * Engineer.
 *
 * An official Mastra workflow that force-calls the read side of the engineer's
 * toolset (current setup, clean-lap evidence, track conditions, version
 * history) up front, every turn, instead of leaving it to the model to decide
 * and to supply a session id. The weak local chat models routinely skipped
 * `get_track_conditions` or fumbled the `sessionId` arg; running the reads as
 * a workflow removes that whole failure class and keeps the agent prompt
 * static — the gathered context is injected as data, so the model only has to
 * reason and act.
 *
 * See docs/architecture/setup-engineer.md:: the symptom/track-conditions
 * single-lap reads are replaced by ONE `loadCleanLapAggregate` call, which
 * reduces the session/branch's laps to a statistically clean pool (spread,
 * confidence, per-corner consistency) instead of trusting the fastest lap in
 * isolation. The lap-by-lap breakdown is surfaced too, so the model can name a
 * specific blunder lap and offer to exclude it via `set_lap_excluded`.
 *
 * The route runs this via `createRun()` → `start({ inputData, requestContext })`,
 * so the step is captured by Mastra observability (Studio). Its `context` output
 * is appended to the engineer's system message; the model then runs with only
 * the action tools (`preview_change` / `apply_changes` /
 * `set_lap_excluded`) plus `consult_lap_analyst` / `compare_lap_consistency`.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { describeKnobs } from "../../server/setups/rules/engine";
import { formatSymptoms } from "../../server/ai/tune-chat-prompt";
import { formatTrackConditions } from "../../server/ai/track-conditions";
import { loadActiveExperimentContext } from "../../server/experiments/setup-lineage";
import {
  loadCleanLapAggregate,
  baselineFallbackNote,
} from "../../server/experiments/lap-evidence/aggregate";
import { formatLapObservations } from "../../server/ai/lap-observations";
import { getOrComputeLapMetricsBatch } from "../../server/lap-analysis/metrics-store";
import { listExperimentVersions } from "../../server/db/experiment-version-queries";

const InputSchema = z.object({
  sessionId: z.number().int().positive().describe("The tuning session id to gather context for."),
});
const OutputSchema = z.object({
  context: z.string().describe("Assembled, human-readable prerequisite context for the engineer prompt."),
});

const gatherPrereqs = createStep({
  id: "gather-prereqs",
  description:
    "Force-call the Setup Engineer read tools (current setup, symptoms, track conditions, version " +
    "history) deterministically so the engineer always reasons from grounded, current data.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    const { sessionId } = inputData;
    const sections: string[] = [];

    // Current setup — the exact tunable knobs + values (the model's action space).
    const ctx = await loadActiveExperimentContext(sessionId);
    if (ctx.ok) {
      const knobs = describeKnobs(ctx.gameId, ctx.setup);
      const tunable = knobs.filter((k) => k.current != null);
      const missing = knobs.filter((k) => k.current == null);
      sections.push(
        `--- CURRENT SETUP (v${ctx.activeTest?.version ?? 0}) — the ONLY knobs you may move ---\n` +
          tunable.map((k) => `${k.component}: ${k.current} [${k.min}..${k.max}]`).join("\n") +
          (missing.length
            ? `\n--- NOT TUNABLE ON THIS CAR (value: None — never suggest or apply changes to these) ---\n` +
              missing.map((k) => `${k.component}: None`).join("\n")
            : ""),
      );
    } else {
      sections.push(`--- CURRENT SETUP ---\n(unavailable: ${ctx.error})`);
    }

    // Clean-lap evidence bundle: confidence, per-lap breakdown, per-corner
    // consistency, aggregated symptoms, and track conditions — all reduced
    // from the session/branch's statistically clean lap pool in one call.
    const agg = await loadCleanLapAggregate(sessionId);
    const { consistency } = agg;

    const confidenceLines = [
      `confidence: ${consistency.confidence.toUpperCase()}`,
      `clean laps: ${consistency.cleanLapCount}`,
      `best lap: ${consistency.bestLapSec != null ? `${consistency.bestLapSec.toFixed(3)}s` : "n/a"}`,
      `spread: ${consistency.spreadSec != null ? `${consistency.spreadSec.toFixed(3)}s` : "n/a"}` +
        (consistency.spreadPct != null ? ` (${(consistency.spreadPct * 100).toFixed(2)}%)` : ""),
      `dropped outliers: ${consistency.droppedOutliers}`,
      `fallback to single lap: ${agg.fallbackSingleLap}`,
      `source: ${agg.sourceScope}`,
    ];
    if (agg.sourceScope === "session-baseline") {
      confidenceLines.push("(session baseline pool — laps may mix setups; confidence capped at medium)");
    }
    // The current setup version has never been driven: the lap pool below is
    // earlier versions' laps, and the model must not judge this version by it.
    const fallbackNote = baselineFallbackNote(agg);
    if (fallbackNote) confidenceLines.push(fallbackNote);
    if (agg.fallbackSingleLap) {
      confidenceLines.push(
        "(only <2 clean laps — reasoning from the single fastest lap; treat suggestions as low-confidence)",
      );
    }
    sections.push(`--- CONFIDENCE ---\n${confidenceLines.join("\n")}`);

    sections.push(
      "--- LAP BREAKDOWN ---\n" +
        (agg.lapBreakdown.length
          ? agg.lapBreakdown
              .map((r) => `lap ${r.lapId}: ${r.lapTimeSec.toFixed(3)}s — ${r.reason}${r.imported ? " (imported)" : ""}`)
              .join("\n")
          : "No laps recorded for this session yet."),
    );

    sections.push(
      "--- CONSISTENCY BY CORNER ---\n" +
        (consistency.cornerConsistency
          ? consistency.cornerConsistency
              .map(
                (c) =>
                  `${c.corner}: line ±${c.lateralSpreadM.toFixed(2)}m, brakeVar ${c.brakeVar.toFixed(2)}, ` +
                  `throttleVar ${c.throttleVar.toFixed(2)}${c.lowTrust ? " — LOW TRUST (driving inconsistency, not the car)" : ""}`,
              )
              .join("\n")
          : "Not enough clean laps to measure line/input consistency."),
    );

    // Compact race-line spread summary (trimmed p90-p10 metres) — worst 3
    // corners only, never the raw per-bin trace (that's for the chart, not
    // the model's context window).
    sections.push(
      "--- LINE SPREAD (trimmed, p90-p10) ---\n" +
        (consistency.lineSpread
          ? (() => {
              const ls = consistency.lineSpread!;
              const worst = [...ls.perCorner].sort((a, b) => b.lateralSpreadM - a.lateralSpreadM).slice(0, 3);
              return (
                `consistency: ${ls.consistencyScore}/100, overall: ${ls.overallSpreadM.toFixed(2)}m over ${ls.lapCount} laps${ls.lowTrust ? " — LOW TRUST" : ""}\n` +
                `worst corners: ${worst.map((c) => `${c.corner} ${c.lateralSpreadM.toFixed(2)}m${c.lowTrust ? " (low trust)" : ""}`).join(", ")}`
              );
            })()
          : "Not enough clean laps (need ≥ 3) to measure racing-line spread."),
    );

    sections.push(
      `--- SYMPTOMS (aggregate over ${consistency.cleanLapCount} clean laps) ---\n` +
        (agg.symptoms ? formatSymptoms(agg.symptoms) : "No analysable lap yet — reason from the driver's description."),
    );

    // Raw driving observations over the same clean pool. Deliberately separate
    // from SYMPTOMS above: symptoms are already an interpretation (understeer,
    // etc.), these are the underlying measurements, with no problem framing and
    // no knowledge of which experiment is running. Cached per lap in
    // `lap_metrics`, so a week-long experiment does not re-decode every .bin.
    const metricsByLap = await getOrComputeLapMetricsBatch(agg.lapIds);
    sections.push(
      `--- DRIVING OBSERVATIONS (raw measurements) ---\n${formatLapObservations([...metricsByLap.values()])}`,
    );

    sections.push(
      "--- TRACK CONDITIONS ---\n" +
        (agg.trackConditions ? formatTrackConditions(agg.trackConditions) : "No conditions data for this session yet."),
    );

    // What's already been tried this session, so the model doesn't repeat it.
    // This is the one test-scoped block: the experiment frame (what was expected
    // and what the driver concluded) belongs to a version, unlike the
    // observations above which are properties of a lap. A verdict is only ever
    // present because a human recorded it.
    const tests = ctx.ok ? ctx.tests : await listExperimentVersions(sessionId);
    sections.push(
      "--- VERSION HISTORY (oldest first) ---\n" +
        (tests.length
          ? tests
              .map((t) => {
                const frame = [
                  t.hypothesis ? `expected: ${t.hypothesis}` : null,
                  t.prediction ? `prediction: ${t.prediction}` : null,
                  t.verdict ? `driver's verdict: ${t.verdict}` : null,
                  t.notes ? `note: ${t.notes}` : null,
                ].filter((s): s is string => s != null);
                return (
                  `v${t.version} "${t.label}"${t.kind === "drill" ? " (driving drill)" : ""}` +
                  `${t.engine ? ` (${t.engine})` : ""}` +
                  (frame.length ? ` — ${frame.join("; ")}` : "")
                );
              })
              .join("\n")
          : "none yet"),
    );

    return { context: sections.join("\n\n") };
  },
});

export const setupEngineerTurnWorkflow = createWorkflow({
  id: "setup-engineer-turn",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(gatherPrereqs);
setupEngineerTurnWorkflow.commit();
