import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { computeChildLabel, nextFreeLabel } from "../../server/ai/version-label";
import { recordAction } from "../../server/db/experiment-action-queries";
import { getExperiment, setSessionHead } from "../../server/db/experiment-queries";
import { createExperimentVersion, listExperimentVersions, nextVersion } from "../../server/db/experiment-version-queries";
import { wsManager } from "../../server/runtime/websocket-manager";
import type { DrillChange } from "../../shared/types";
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
const recordDrillTool = createTool({
  id: "record-drill",
  description:
    "Record the driving drill the driver just confirmed as the session's next version, so laps can be " +
    "measured against it. A drill has no setup file — it changes what the DRIVER does. Call this ONCE, " +
    "after the driver has explicitly agreed to run the drill you proposed. To branch off a specific " +
    "version instead of the current head, pass `target`.",
  inputSchema: z.object({
    title: z.string().min(1).max(200).describe('Short imperative name, e.g. "Brake 10m later into T4".'),
    instruction: z
      .string()
      .min(1)
      .max(2000)
      .describe("What the driver actually does, in enough detail that they can repeat it identically every lap."),
    corners: z
      .array(z.string())
      .default([])
      .describe('Corner labels the drill targets, e.g. ["T4", "Les Combes"]. Empty means lap-wide.'),
    reason: z.string().min(1).describe("One short sentence: why this drill, grounded in the session's data."),
    driverConfirmed: z
      .boolean()
      .describe(
        'true ONLY if the driver explicitly agreed to run this exact drill in a message AFTER you proposed it (e.g. "yes", "let\'s try it"). false otherwise.',
      ),
    target: z
      .string()
      .optional()
      .describe("Label or version number to branch from (becomes the new arm's parent). Omit to use the current head."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    version: z.number().optional(),
    label: z.string().optional(),
  }),
  execute: async (inputData, execCtx) => {
    const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);

    // Same hard gate as apply-changes: the model must attest the driver
    // approved. Weak models skip propose→confirm and jump to recording.
    if (!inputData.driverConfirmed) {
      return {
        ok: false,
        error:
          "Not recorded — the driver has not confirmed. Propose the drill, ask them, and only call " +
          "record_drill (driverConfirmed: true) after they explicitly agree.",
      };
    }

    const session = await getExperiment(sessionId);
    if (!session) return { ok: false, error: "Experiment not found." };

    const versions = await listExperimentVersions(sessionId);
    let parent = versions.find((t) => t.id === session.headVersionId) ?? versions[versions.length - 1];

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

    // `nextVersion` counts deleted rows too; `versions` here does not
    // (`listExperimentVersions` filters `status='deleted'`). Deriving the number
    // from this list reissues the version of a soft-deleted arm, and nothing in
    // the schema stops it — so ask the DB, exactly as the routes do.
    const nextVer = await nextVersion(sessionId);
    const parentLabel = parent?.label ?? "v1";
    const childCount = parent ? versions.filter((t) => t.parentVersionId === parent!.id).length : 0;
    const label = nextFreeLabel(computeChildLabel(parentLabel, childCount), new Set(versions.map((t) => t.label)));

    const change: DrillChange = {
      kind: "drill",
      title: inputData.title.trim(),
      instruction: inputData.instruction.trim(),
      corners: inputData.corners.map((c) => c.trim()).filter(Boolean),
      reason: inputData.reason.trim(),
    };

    const versionId = await createExperimentVersion({
      experimentId: sessionId,
      version: nextVer,
      label,
      // The point of a drill: no file, no snapshot. Passing kind explicitly
      // rather than leaning on the experiment's focus, because this tool
      // records a drill by definition — even if the driver flipped focus back
      // to the car between proposing and confirming.
      kind: "drill",
      setupPath: null,
      setupSnapshot: null,
      parentVersionId: parent?.id ?? null,
      appliedChanges: JSON.stringify([change]),
      notes: change.title,
      engine: "llm",
    });

    // The head being overwritten, not the branch parent — with `target` set
    // those differ, and undo must put the driver back where they were. Same as
    // apply-changes and the route handlers.
    const prevHeadTestId = session.headVersionId ?? parent?.id ?? null;
    // NOT best-effort. If the head does not advance, the arm exists but the
    // session still points at its parent: the next drill branches off a stale
    // node and the driver was told otherwise. Report it instead of returning ok.
    try {
      await setSessionHead(sessionId, versionId);
    } catch (err: any) {
      console.error("[DriverCoach] Failed to advance head:", err?.message);
      wsManager.broadcastNotification({ type: "experiment-updated", sessionId });
      return {
        ok: false,
        version: nextVer,
        label,
        error:
          `Recorded ${label}, but the session head could not be advanced to it, so it is not the ` +
          `current arm. Tell the driver to select ${label} manually before running laps; do not ` +
          `call record_drill again for this drill.`,
      };
    }

    wsManager.broadcastNotification({ type: "experiment-updated", sessionId });

    // Best-effort, same as apply-changes: the arm is already committed, and an
    // action-log failure must not fail the call. Logged as "apply-changes" so
    // the existing undo path handles a drill arm identically to a setup one.
    try {
      await recordAction(sessionId, "apply-changes", { versionId, prevHeadTestId });
    } catch (err: any) {
      console.error("[DriverCoach] Failed to log record-drill action:", err?.message);
    }

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
