import type { Mastra } from "@mastra/core/mastra";
import type { Dataset } from "@mastra/core/datasets";
import type { DatasetItem, DatasetItemToolMock, DatasetUnmockedToolPolicy } from "@mastra/core/storage";
import { DEFAULT_MODEL_IDS } from "./model-eval-config";

export type DatasetItemPayload = {
  externalId: string; input: unknown; groundTruth?: unknown; metadata?: Record<string, unknown>;
  expectedTrajectory?: unknown; toolMocks?: DatasetItemToolMock[]; unmockedToolPolicy?: DatasetUnmockedToolPolicy;
};
export const SETUP_ENGINEER_MODEL_EVAL_DATASET_ID = "raceiq-model-eval-setup-engineer";
export const SETUP_ENGINEER_MODEL_EVAL_DATASET_NAME = "RaceIQ model eval — setup engineer";
const MUTATING_TOOLS = ["apply-changes", "set-lap-excluded", "update-notes", "record-driver-notes", "delete-version", "undo-last-action"] as const;
export interface SetupEngineerEvalFixture { fixtureId: string; gameId: string; sessionId: number; input: string; groundTruth: { expectedChange: { component: string; direction: string; magnitude: string } }; }
export interface SetupEngineerModelEvalDefinition { id: string; name: string; targetId: "setup-engineer"; scorerIds: readonly string[]; items: readonly DatasetItemPayload[]; }
function mutationMock(toolName: string, args: Record<string, unknown>, output: unknown = { ok: false, error: "Fixture-backed evaluation is read-only" }) { return { toolName, args, output }; }
export function setupEngineerModelEvalModelIds(requested: readonly string[]): string[] { return [...(requested.length ? requested : DEFAULT_MODEL_IDS)]; }
export function buildSetupEngineerModelEvalDefinition(fixture: SetupEngineerEvalFixture = { fixtureId: "acc-setup-confirmation", gameId: "acc", sessionId: 9001, input: "The car understeers on corner entry. Analyze the lap, preview a small front anti-roll bar increase, then apply it after I confirm.", groundTruth: { expectedChange: { component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small" } } }): SetupEngineerModelEvalDefinition {
  const change = { ...fixture.groundTruth.expectedChange, reason: "Reduce corner-entry understeer" };
  const previewChange = fixture.groundTruth.expectedChange;
  const toolMocks = [
    mutationMock("consult-lap-analyst", {}, { available: true, summary: "Corner-entry understeer is consistent and setup-related." }),
    mutationMock("preview-change", previewChange, { ok: true, noop: false, from: 5, to: 6 }),
    mutationMock("apply-changes", { changes: [change], goal: "Reduce corner-entry understeer", driverConfirmed: true }, { ok: true, version: 2, applied: [change], skipped: [] }),
    ...MUTATING_TOOLS.filter((tool) => tool !== "apply-changes").map((tool) => mutationMock(tool, tool === "set-lap-excluded" ? { lapId: 1, excluded: true } : tool === "delete-version" ? { versionId: 1 } : tool === "update-notes" ? { note: "" } : tool === "record-driver-notes" ? { note: "", driverConfirmed: true } : {})),
  ];
  return { id: SETUP_ENGINEER_MODEL_EVAL_DATASET_ID, name: SETUP_ENGINEER_MODEL_EVAL_DATASET_NAME, targetId: "setup-engineer", scorerIds: ["code-trajectory-scorer", "check-no-tool-errors"], items: [{ externalId: `${fixture.fixtureId}-repeat-1`, input: fixture.input, groundTruth: fixture.groundTruth, metadata: { fixtureId: fixture.fixtureId, gameId: fixture.gameId, sessionId: fixture.sessionId, agent: "setup-engineer" }, toolMocks, unmockedToolPolicy: "deny", expectedTrajectory: { steps: [{ toolName: "consult-lap-analyst", toolArgs: {} }, { toolName: "preview-change", toolArgs: previewChange }, { toolName: "apply-changes", toolArgs: { changes: [change], goal: "Reduce corner-entry understeer", driverConfirmed: true } }], allowRepeatedSteps: false, noRedundantCalls: true, maxSteps: 8 } }] };
}
function canonical(value: unknown): string { return JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v); }
export async function syncSetupEngineerModelEvalDataset(mastra: Mastra, definition: SetupEngineerModelEvalDefinition): Promise<{ dataset: Dataset; version: number }> {
  let dataset: Dataset | undefined; let page = 0;
  do { const listed = await mastra.datasets.list({ page, perPage: 100 }); const found = listed.datasets.find((d) => d.id === definition.id); if (found) dataset = await mastra.datasets.get({ id: definition.id }); else { page++; if (!listed.pagination.hasMore) break; } } while (!dataset);
  if (!dataset) dataset = await mastra.datasets.create({ id: definition.id, name: definition.name, targetType: "agent", targetIds: [definition.targetId], scorerIds: [...definition.scorerIds] });
  const listed = await dataset.listItems({ page: 0, perPage: 100 }); const existing = (Array.isArray(listed) ? listed : listed.items) as unknown as DatasetItem[]; const expected = new Map(definition.items.map((i) => [i.externalId, i]));
  if (expected.size !== definition.items.length || existing.some((i) => !i.externalId || !expected.has(i.externalId))) throw new Error("Setup eval dataset items mismatch");
  for (const item of definition.items) { const old = existing.find((i) => i.externalId === item.externalId); if (!old) await dataset.addItem(item); else { const oldPayload = Object.fromEntries(Object.entries({ externalId: old.externalId, input: old.input, groundTruth: old.groundTruth, expectedTrajectory: old.expectedTrajectory, toolMocks: old.toolMocks, unmockedToolPolicy: old.unmockedToolPolicy, metadata: old.metadata }).filter(([, value]) => value !== undefined)); if (canonical(oldPayload) !== canonical(item)) await (dataset as unknown as { updateItem: (x: unknown) => Promise<unknown> }).updateItem({ itemId: old.id, ...item }); } }
  const versions = await dataset.listVersions({ page: 0, perPage: 1 });
  return { dataset, version: versions.versions[0]?.version ?? 1 };
}
