import { z } from "zod";
import type { CodexTool } from "./runtime";
import { getCornerMetricsTool } from "../../mastra/tools/corner-metrics";
import { getLapInsightsTool } from "../../mastra/tools/lap-insights";
import { getLapAnalysisTool } from "../../mastra/tools/lap-analysis";
import { getCompareAnalysisTool } from "../../mastra/tools/compare-analysis";
import { getTrackGuideTool, listTrackGuidesTool } from "../../mastra/tools/track-guide";
import { compareF1SetupToCatalogTool } from "../../mastra/tools/f1-setup-compare";

export type RequestContextLike = { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
export type MastraToolLike = {
  description: string;
  inputSchema?: unknown;
  execute?: (...args: never[]) => Promise<unknown>;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}

function codexTool(
  access: CodexTool["access"],
  description: string,
  input: z.ZodType,
  execute: (input: unknown, signal: AbortSignal) => Promise<unknown>,
): CodexTool {
  return {
    access,
    description,
    input,
    inputSchema: z.toJSONSchema(input),
    async execute(inputData, signal) {
      if (signal.aborted) throw new Error("Codex tool call cancelled.");
      return asText(await execute(inputData, signal));
    },
  };
}

export function executeMastraTool(
  tool: MastraToolLike,
  input: unknown,
  requestContext: RequestContextLike,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("Codex tool call cancelled.");
  if (!tool.execute) throw new Error(`Mastra tool is not executable: ${tool.description}`);
  const execute = tool.execute as unknown as (input: unknown, context: unknown) => Promise<unknown>;
  return execute(input, { requestContext, abortSignal: signal });
}

export function buildMastraCodexTools(
  tools: Readonly<Record<string, { tool: MastraToolLike; access: CodexTool["access"] }>>,
  requestContext: RequestContextLike,
): Readonly<Record<string, CodexTool>> {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const inputSchema = entry.tool.inputSchema;
    if (!inputSchema) throw new Error(`Codex tool ${name} has no input schema.`);
    // Mastra exposes Zod inputs through StandardSchemaWithJSON; these tools
    // are authored with Zod, so recover its concrete schema at this boundary.
    const zodInput = inputSchema as z.ZodType;
    return [name, codexTool(entry.access, entry.tool.description, zodInput, (input, signal) =>
      executeMastraTool(entry.tool, input, requestContext, signal))];
  }));
}

/** Expose telemetry reads only for selected lap. Never trust model-supplied lap IDs. */
export function buildLapChatCodexTools(input: {
  lapId: number;
  trackName: string;
  requestContext: RequestContextLike;
  includeF1Setup?: boolean;
}): Readonly<Record<string, CodexTool>> {
  const context = input.requestContext;
  return {
    get_lap_insights: codexTool("read", getLapInsightsTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(getLapInsightsTool, { lapId: input.lapId }, context, signal)),
    get_corner_metrics: codexTool("read", getCornerMetricsTool.description, z.object({ cornerId: z.number().int().positive().optional() }).strict(), (args, signal) =>
      executeMastraTool(getCornerMetricsTool, { lapId: input.lapId, ...(args as { cornerId?: number }) }, context, signal)),
    get_lap_analysis: codexTool("read", getLapAnalysisTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(getLapAnalysisTool, { lapId: input.lapId }, context, signal)),
    get_track_guide: codexTool("read", getTrackGuideTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(getTrackGuideTool, { trackName: input.trackName }, context, signal)),
    list_track_guides: codexTool("read", listTrackGuidesTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(listTrackGuidesTool, {}, context, signal)),
    ...(input.includeF1Setup ? {
      compare_f1_setup_to_catalog: codexTool("read", compareF1SetupToCatalogTool.description, z.object({ limit: z.number().int().min(1).max(10).optional() }).strict(), (args, signal) =>
        executeMastraTool(compareF1SetupToCatalogTool, { lapId: input.lapId, ...(args as { limit?: number }) }, context, signal)),
    } : {}),
  };
}

/** Comparison tool inputs identify side, not database IDs; current lap IDs stay server-owned. */
export function buildComparisonChatCodexTools(input: {
  lapAId: number;
  lapBId: number;
  trackName: string;
  requestContext: RequestContextLike;
  includeF1Setup?: boolean;
}): Readonly<Record<string, CodexTool>> {
  const context = input.requestContext;
  const sideInput = z.object({ lapSide: z.enum(["A", "B"]) }).strict();
  const sideCornerInput = z.object({ lapSide: z.enum(["A", "B"]), cornerId: z.number().int().positive().optional() }).strict();
  const selectedLap = (side: "A" | "B") => side === "A" ? input.lapAId : input.lapBId;
  return {
    get_compare_analysis: codexTool("read", getCompareAnalysisTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(getCompareAnalysisTool, { lapAId: input.lapAId, lapBId: input.lapBId }, context, signal)),
    get_lap_analysis: codexTool("read", getLapAnalysisTool.description, sideInput, (args, signal) =>
      executeMastraTool(getLapAnalysisTool, { lapId: selectedLap((args as { lapSide: "A" | "B" }).lapSide) }, context, signal)),
    get_corner_metrics: codexTool("read", getCornerMetricsTool.description, sideCornerInput, (args, signal) => {
      const value = args as { lapSide: "A" | "B"; cornerId?: number };
      return executeMastraTool(getCornerMetricsTool, { lapId: selectedLap(value.lapSide), ...(value.cornerId === undefined ? {} : { cornerId: value.cornerId }) }, context, signal);
    }),
    get_track_guide: codexTool("read", getTrackGuideTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(getTrackGuideTool, { trackName: input.trackName }, context, signal)),
    list_track_guides: codexTool("read", listTrackGuidesTool.description, z.object({}).strict(), (_args, signal) =>
      executeMastraTool(listTrackGuidesTool, {}, context, signal)),
    ...(input.includeF1Setup ? {
      compare_f1_setup_to_catalog: codexTool("read", compareF1SetupToCatalogTool.description, z.object({ lapSide: z.enum(["A", "B"]), limit: z.number().int().min(1).max(10).optional() }).strict(), (args, signal) => {
        const value = args as { lapSide: "A" | "B"; limit?: number };
        return executeMastraTool(compareF1SetupToCatalogTool, { lapId: selectedLap(value.lapSide), ...(value.limit === undefined ? {} : { limit: value.limit }) }, context, signal);
      }),
    } : {}),
  };
}
