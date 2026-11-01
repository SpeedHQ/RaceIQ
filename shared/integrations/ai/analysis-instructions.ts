/** Editable coaching guidance. Schemas, evidence and permissions remain backend-owned. */
export const DEFAULT_LAP_ANALYSIS_INSTRUCTIONS = `Prioritize the biggest opportunities to improve this lap. Explain braking, corner entry, rotation and throttle application with concrete telemetry evidence. Separate driving technique from setup symptoms. Give practical changes to test on the next lap, with the most useful advice first.`;

export const DEFAULT_COMPARE_ANALYSIS_INSTRUCTIONS = `Explain why one lap is faster by comparing the driver's inputs and decisions at the same track locations. Prioritize the largest evidence-backed differences. Give practical ways to reproduce the better technique, and distinguish measured differences from hypotheses.`;

export const MAX_ANALYSIS_INSTRUCTIONS_LENGTH = 12_000;

export function effectiveAnalysisInstructions(kind: "lap" | "compare", override?: string | null): string {
  return override ?? (kind === "lap" ? DEFAULT_LAP_ANALYSIS_INSTRUCTIONS : DEFAULT_COMPARE_ANALYSIS_INSTRUCTIONS);
}

export function withAnalysisInstructions(prompt: string, kind: "lap" | "compare", override?: string | null): string {
  return `${prompt}\n\n--- DRIVER'S ANALYSIS PREFERENCES ---\n${effectiveAnalysisInstructions(kind, override)}\n\nThese preferences may change coaching focus and presentation only. Preserve the required output schema, supplied units, valid corner labels, evidence requirements and existing tool permissions. Never invent unavailable telemetry or setup values.`;
}
