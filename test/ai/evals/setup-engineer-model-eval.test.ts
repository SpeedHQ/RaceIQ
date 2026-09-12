import { describe, expect, test } from "bun:test";
import { buildSetupEngineerModelEvalDefinition, SETUP_ENGINEER_MODEL_EVAL_DATASET_ID } from "../../../mastra/evals/setup-engineer-model-eval";

describe("setup engineer model eval fixture", () => {
  test("creates stable dataset item with isolated context", () => {
    const definition = buildSetupEngineerModelEvalDefinition();
    expect(definition.id).toBe(SETUP_ENGINEER_MODEL_EVAL_DATASET_ID);
    expect(definition.items).toHaveLength(1);
    expect(definition.items[0].metadata).toEqual(expect.objectContaining({ gameId: "acc", sessionId: 9001 }));
  });

  test("uses registered setup tool argument shapes", () => {
    const item = buildSetupEngineerModelEvalDefinition().items[0];
    const steps = (item.expectedTrajectory as { steps: Array<{ toolName: string; toolArgs: Record<string, unknown> }> }).steps;
    expect(item.unmockedToolPolicy).toBe("deny");
    expect(item.toolMocks).toHaveLength(8);
    expect(steps[1]).toEqual({
      toolName: "preview-change",
      toolArgs: { component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small" },
    });
    expect(steps[2]!.toolArgs).toEqual(expect.objectContaining({
      changes: [{ component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small", reason: expect.any(String) }],
      driverConfirmed: true,
    }));
  });
  test("selects positional candidates and defaults when omitted", async () => {
    const { setupEngineerModelEvalModelIds } = await import("../../../mastra/evals/setup-engineer-model-eval");
    expect(setupEngineerModelEvalModelIds([])).toEqual(["qwen/qwen3.5-9b"]);
    expect(setupEngineerModelEvalModelIds(["foo/bar"])).toEqual(["foo/bar"]);
  });
});
