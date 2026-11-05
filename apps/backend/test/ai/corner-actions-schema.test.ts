import { describe, expect, test } from "bun:test";
import { AnalystModelOutputSchema } from "@raceiq/backend-core/ai/output-schema";
import { InputsCompareSchema } from "@raceiq/backend-core/ai/inputs-compare-prompt";
import { getAnalystJsonSchema, renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";
import { CORNER_ACTIONS_PROMPT, CHAT_CORNER_ACTIONS_PROMPT } from "@raceiq/shared/integrations/ai/prompt-snippets";

const action = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  cornerKey: "T1",
  label: "T1",
  target: "solo",
  path: "verdict",
  span: { start: 0, end: 2 },
  ...overrides,
});

const analyst = (actions: unknown[] = []) => ({
  verdict: "Brake later into T1.",
  pace: [],
  handling: [],
  corners: [],
  technique: [],
  setup: [],
  actions,
});

const inputs = (actions: unknown[] = []) => ({
  verdict: "Lap A gains in T1.",
  segments: [{ name: "T1", deltaSeconds: -0.1, throttle: "x", brake: "x", steering: "x", action: "Brake later into T1.", severity: "minor" }],
  coaching: [],
  actions,
});

describe("corner action structured output", () => {
  test("analyst schema defaults actions and drops malformed entries individually", () => {
    expect(AnalystModelOutputSchema.parse(analyst()).actions).toEqual([]);
    const parsed = AnalystModelOutputSchema.parse(analyst([action(), action({ span: { start: 4, end: 4 } }), action({ target: "C" })]));
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]?.path).toBe("verdict");
  });

  test("inputs comparison schema defaults actions and drops malformed entries", () => {
    expect(InputsCompareSchema.parse(inputs()).actions).toEqual([]);
    const parsed = InputsCompareSchema.parse(inputs([action({ target: "A", path: "segments[0].action" }), action({ path: 7 })]));
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]?.target).toBe("A");
  });

  test("the rendered model schema includes actions", () => {
    expect(renderAnalystSchemaForPrompt()).toContain('"actions"');
    expect(JSON.stringify(getAnalystJsonSchema())).toContain('"actions"');
  });

  test("prompt snippets name the action fields and chat tool", () => {
    expect(CORNER_ACTIONS_PROMPT).toContain("path");
    expect(CORNER_ACTIONS_PROMPT).toContain("span");
    expect(CHAT_CORNER_ACTIONS_PROMPT).toContain("corner_actions");
    expect(CHAT_CORNER_ACTIONS_PROMPT).toContain("span");
  });
});
