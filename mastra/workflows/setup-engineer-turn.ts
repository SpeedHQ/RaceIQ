/**
 * setup-engineer-turn — deterministic prerequisite gathering for the Setup
 * Engineer.
 *
 * An official Mastra workflow that force-calls the read side of the engineer's
 * toolset (current setup, symptoms, track conditions, version history) up front,
 * every turn, instead of leaving it to the model to decide and to supply a
 * session id. The weak local chat models routinely skipped `get_track_conditions`
 * or fumbled the `sessionId` arg; running the reads as a workflow removes that
 * whole failure class and keeps the agent prompt static — the gathered context
 * is injected as data, so the model only has to reason and act.
 *
 * The route runs this via `createRun()` → `start({ inputData, requestContext })`,
 * so the step is captured by Mastra observability (Studio). Its `context` output
 * is appended to the engineer's system message; the model then runs with only
 * the action tools (`preview_change` / `apply_changes` / `branch_from_version`)
 * plus `consult_lap_analyst`.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { describeKnobs } from "../../server/ai/tune-rules";
import { formatSymptoms } from "../../server/ai/tune-chat-prompt";
import {
  computeSessionSymptoms,
  computeSessionTrackConditions,
  formatTrackConditions,
  loadActiveTuningContext,
} from "../../server/ai/setup-engineer-context";
import { listTuningTests } from "../../server/db/tuning-test-queries";

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
    const ctx = await loadActiveTuningContext(sessionId);
    if (ctx.ok) {
      const knobs = describeKnobs(ctx.gameId, ctx.setup);
      sections.push(
        `--- CURRENT SETUP (v${ctx.activeTest?.version ?? 0}) — the ONLY knobs you may move ---\n` +
          knobs.map((k) => `${k.component}: ${k.current ?? "?"} [${k.min}..${k.max}]`).join("\n"),
      );
    } else {
      sections.push(`--- CURRENT SETUP ---\n(unavailable: ${ctx.error})`);
    }

    // Deterministic symptom report over the representative lap.
    const symptoms = await computeSessionSymptoms(sessionId);
    sections.push(
      "--- SYMPTOMS (deterministic, from the session's fastest lap) ---\n" +
        (symptoms ? formatSymptoms(symptoms) : "No analysable lap yet — reason from the driver's description."),
    );

    // Weather / track-surface conditions for the same lap.
    const conditions = await computeSessionTrackConditions(sessionId);
    sections.push(
      "--- TRACK CONDITIONS ---\n" +
        (conditions ? formatTrackConditions(conditions) : "No conditions data for this session yet."),
    );

    // What's already been tried this session, so the model doesn't repeat it.
    const tests = ctx.ok ? ctx.tests : await listTuningTests(sessionId);
    sections.push(
      "--- VERSION HISTORY (oldest first) ---\n" +
        (tests.length
          ? tests.map((t) => `v${t.version} "${t.label}"${t.engine ? ` (${t.engine})` : ""}`).join(", ")
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
