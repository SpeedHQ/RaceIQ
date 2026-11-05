import type { CodexTool, CodexToolRole } from "./runtime";
import type { RequestContextLike } from "./chat-tools";
import { buildMastraCodexTools } from "./chat-tools";
import { buildSetupEngineerTools } from "../../mastra/tools/setup-engineer";
import { buildDriverCoachTools } from "../../mastra/tools/driver-coach";

/** Preserve specialist-specific tool authority when exposing experiment tools to Codex. */
export function buildExperimentCodexTools(
  role: Extract<CodexToolRole, "engineer" | "coach">,
  requestContext: RequestContextLike,
): Readonly<Record<string, CodexTool>> {
  const engineer = buildSetupEngineerTools();
  const coach = role === "coach" ? buildDriverCoachTools() : null;
  const common = {
    get_symptoms: { tool: engineer.getSymptomsTool, access: "read" as const },
    get_track_conditions: { tool: engineer.getTrackConditionsTool, access: "read" as const },
    consult_lap_analyst: { tool: engineer.consultLapAnalystTool, access: "read" as const },
    get_version_history: { tool: engineer.getVersionHistoryTool, access: "read" as const },
    set_lap_excluded: { tool: engineer.setLapExcludedTool, access: "experiment" as const },
    update_notes: { tool: engineer.updateNotesTool, access: "experiment" as const },
    record_driver_notes: { tool: engineer.recordDriverNotesTool, access: "experiment" as const },
    compare_lap_consistency: { tool: engineer.compareLapConsistencyTool, access: "read" as const },
    list_laps: { tool: engineer.listLapsTool, access: "read" as const },
    get_lap_detail: { tool: engineer.getLapDetailTool, access: "read" as const },
    get_lap_issues: { tool: engineer.getLapIssuesTool, access: "read" as const },
    compare_laps: { tool: engineer.compareLapsTool, access: "read" as const },
  };
  if (role === "engineer") {
    return buildMastraCodexTools({
      ...common,
      get_setup: { tool: engineer.getSetupTool, access: "read" },
      preview_change: { tool: engineer.previewChangeTool, access: "read" },
      apply_changes: { tool: engineer.applyChangesTool, access: "engineer" },
      delete_version: { tool: engineer.deleteVersionTool, access: "experiment" },
      undo_last_action: { tool: engineer.undoLastActionTool, access: "experiment" },
    }, requestContext);
  }
  if (!coach) throw new Error("Driver Coach tools are unavailable.");
  return buildMastraCodexTools({
    ...common,
    record_drill: { tool: coach.recordDrillTool, access: "coach" },
  }, requestContext);
}
