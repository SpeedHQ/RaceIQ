import { describe, expect, test } from "bun:test";
import { lapAnalystAgent } from "../../../mastra/agents/lap-analyst";
import { compareEngineerAgent } from "../../../mastra/agents/compare-engineer";

describe("Mastra native evaluation targets", () => {
  test("register production agents used by persisted experiments", () => {
    expect(lapAnalystAgent.id).toBe("lap-analyst");
    expect(compareEngineerAgent.id).toBe("compare-engineer");
    expect(lapAnalystAgent).not.toBeUndefined();
  });
});
