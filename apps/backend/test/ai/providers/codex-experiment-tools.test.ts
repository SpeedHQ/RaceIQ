import { describe, expect, test } from "bun:test";
import { buildExperimentCodexTools } from "../../../src/ai/codex/experiment-tools";

const requestContext = { get: () => undefined, set: () => {} };

describe("Codex experiment tool authority", () => {
  test("engineer receives apply_changes and never record_drill", () => {
    const tools = buildExperimentCodexTools("engineer", requestContext);
    expect(Object.keys(tools)).toContain("apply_changes");
    expect(Object.keys(tools)).not.toContain("record_drill");
    expect(tools.apply_changes?.access).toBe("engineer");
    expect(tools.apply_changes?.input.safeParse({}).success).toBe(false);
  });

  test("coach receives record_drill and never apply_changes", () => {
    const tools = buildExperimentCodexTools("coach", requestContext);
    expect(Object.keys(tools)).toContain("record_drill");
    expect(Object.keys(tools)).not.toContain("apply_changes");
    expect(tools.record_drill?.access).toBe("coach");
    expect(tools.record_drill?.input.safeParse({}).success).toBe(false);
  });
});
