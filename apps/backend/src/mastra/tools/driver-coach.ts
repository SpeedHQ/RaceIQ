import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { computeChildLabel, nextFreeLabel } from "@raceiq/backend-core/ai/version-label";
import { getExperiment } from "@raceiq/backend-core/db/experiment-queries";
import { createExperimentVersionAndSetHead, nextVersion } from "@raceiq/backend-core/db/experiment-version-queries";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import type { DrillChange } from "@raceiq/shared/racing/experiments/types";
import { readSetupEngineerContext } from "./setup-engineer-request-context";
import { setupEngineerTools } from "./setup-engineer";

/**
 * Driver Coach tools.
 *
 * The coach shares the race engineer's READ tools — symptoms, lap list, lap
 * detail, consistency, version history — because they describe the session, not
 * the car. What it does NOT get is anything that writes a setup file
 * (`preview-change`, `apply-changes`, `delete-version`, `undo-last-action`):
 * the coach never touches the car, and a tool it cannot legitimately call is
 * better removed than forbidden in a prompt.
 *
 * What it gains is `record-drill`, the write path that did not exist before.
 * Until now a driving-focus experiment could produce no arms at all: every
 * mutating tool went through `applyIntents` + a setup-file write, so a drill
 * could only be hand-seeded (which is exactly what the Storybook fixtures do).
 */

/**
 * record-drill — commit a driving change as an experiment arm.
 *
 * Deliberately NOT routed through `loadActiveExperimentContext` like
 * `apply-changes` is: that helper resolves and reads a base setup FILE and
 * fails when there is none, and a driving experiment legitimately has none
 * (the driver may just be working on braking in whatever they are running).
 * The arm is a version row with `kind='drill'`, no `setupPath`, no
 * `setupSnapshot` — the schema has allowed that since v37.
 */
const recordDrillInputSchema = z.object({
  title: z.string().min(1).max(200).describe('Short imperative name, e.g. "Brake 10m later into T4".'),
  instruction: z.string().min(1).max(2000).describe("What the driver actually does, in enough detail that they can repeat it identically every lap."),
  corners: z.array(z.string()).default([]).describe('Corner labels the drill targets, e.g. ["T4", "Les Combes"]. Empty means lap-wide.'),
  reason: z.string().min(1).describe("One short sentence: why this drill, grounded in the session's data."),
  driverConfirmed: z.boolean().describe('true ONLY if the driver explicitly agreed to run this exact drill in a message AFTER you proposed it (e.g. "yes", "let\'s try it"). false otherwise.'),
  target: z.string().optional().describe("Label or version number to branch from (becomes the new arm's parent). Omit to use the current head."),
});
export const recordDrillOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  version: z.number().optional(),
  label: z.string().optional(),
});

export type RecordDrillInput = z.infer<typeof recordDrillInputSchema>;
export type RecordDrillResult = z.infer<typeof recordDrillOutputSchema>;

const recordDrillTool = createTool({
  id: "record-drill",
  description:
    "Record the driving drill the driver just confirmed as the session's next version, so laps can be " +
    "measured against it. A drill has no setup file — it changes what the DRIVER does. Call this ONCE, " +
    "after the driver has explicitly agreed to run the drill you proposed. To branch off a specific " +
    "version instead of the current head, pass `target`.",
  inputSchema: recordDrillInputSchema,
  outputSchema: recordDrillOutputSchema,
  execute: async (inputData, execCtx) => {
    const { sessionId, branch, mutations } = readSetupEngineerContext(execCtx?.requestContext);
    // Same hard gate as apply-changes: the model must attest the driver
    // approved. Weak models skip propose→confirm and jump to recording.
    if (!inputData.driverConfirmed) {
      return {
        ok: false,
        error: "Not recorded — the driver has not confirmed. Propose the drill, ask them, and only call " + "record_drill (driverConfirmed: true) after they explicitly agree.",
      };
    }

    const versions = branch.versions;
    let parent = branch.activeVersion ?? undefined;

    if (inputData.target) {
      const raw = inputData.target.trim();
      const stripped = raw.replace(/^v/i, "");
      const asNum = Number(stripped);
      const match =
        versions.find((t) => t.label.toLowerCase() === raw.toLowerCase()) ??
        versions.find((t) => t.label.toLowerCase() === stripped.toLowerCase()) ??
        (Number.isFinite(asNum) ? versions.find((t) => t.version === asNum) : undefined);
      if (!match) return { ok: false, error: `No version matching "${inputData.target}" in this session.` };
      parent = match;
    }
    const currentSession = await getExperiment(sessionId);
    if (!currentSession || currentSession.headVersionId !== mutations.expectedHeadVersionId) {
      return { ok: false, error: "Experiment version changed during this turn. Refresh before recording a drill." };
    }

    // `nextVersion` counts deleted rows too; `versions` here does not
    // (`listExperimentVersions` filters `status='deleted'`). Deriving the number
    // from this list reissues the version of a soft-deleted arm, and nothing in
    // the schema stops it — so ask the DB, exactly as the routes do.
    const nextVer = await nextVersion(sessionId);
    const parentLabel = parent?.label ?? "v1";
    const childCount = parent ? versions.filter((t) => t.parentVersionId === parent!.id).length : 0;
    const label = nextFreeLabel(computeChildLabel(parentLabel, childCount), new Set([...versions.map((t) => t.label), ...mutations.createdLabels]));
    const change: DrillChange = {
      kind: "drill",
      title: inputData.title.trim(),
      instruction: inputData.instruction.trim(),
      corners: inputData.corners.map((c) => c.trim()).filter(Boolean),
      reason: inputData.reason.trim(),
    };

    const prevHeadTestId = mutations.expectedHeadVersionId;
    const versionId = await createExperimentVersionAndSetHead({
      experimentId: sessionId,
      version: nextVer,
      label,
      kind: "drill",
      setupPath: null,
      setupSnapshot: null,
      parentVersionId: parent?.id ?? null,
      appliedChanges: JSON.stringify([change]),
      notes: change.title,
      engine: "llm",
    }, mutations.expectedHeadVersionId, {
      kind: "apply-changes", inversePayload: { versionId: "INSERTED_ID", prevHeadTestId },
    });
    if (versionId == null) {
      return { ok: false, error: "Experiment version changed during this drill update. Refresh before recording a drill." };
    }
    wsManager.broadcastNotification({ type: "experiment-updated", sessionId });
    mutations.expectedHeadVersionId = versionId;
    mutations.createdLabels.add(label);
    return { ok: true, version: nextVer, label };
  },
});

/**
 * The coach's tool set: the engineer's read tools (they describe the session,
 * not the car), plus the drill write path.
 */
export function buildDriverCoachTools() {
  const {
    getSymptomsTool,
    getTrackConditionsTool,
    consultLapAnalystTool,
    getVersionHistoryTool,
    setLapExcludedTool,
    updateNotesTool,
    recordDriverNotesTool,
    compareLapConsistencyTool,
    listLapsTool,
    getLapDetailTool,
    getLapIssuesTool,
    compareLapsTool,
  } = setupEngineerTools;

  return {
    getSymptomsTool,
    getTrackConditionsTool,
    consultLapAnalystTool,
    getVersionHistoryTool,
    setLapExcludedTool,
    updateNotesTool,
    recordDriverNotesTool,
    compareLapConsistencyTool,
    listLapsTool,
    getLapDetailTool,
    getLapIssuesTool,
    compareLapsTool,
    recordDrillTool,
  };
}

export const driverCoachTools = buildDriverCoachTools();
