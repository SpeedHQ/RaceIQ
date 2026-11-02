import { expect, test } from "bun:test";
import { CODEX_TOOL_PROFILE_OVERRIDES, prepareCodexToolModel } from "../../../src/ai/codex/tool-profile";

const metadata = () => ({
  slug: "gpt-6-luna",
  tool_mode: "code_mode_only",
  use_responses_lite: true,
  multi_agent_version: "v2",
  experimental_supported_tools: ["send_user_message_async", "clock"],
  apply_patch_tool_type: "freeform",
  context_window: 272000,
});

test("tool profile removes unapproved capabilities without mutating CLI metadata", () => {
  const original = metadata();
  const result = prepareCodexToolModel(original, "codex-cli 0.164.0");
  expect(result).not.toHaveProperty("tool_mode");
  expect(result).toMatchObject({ slug: "gpt-6-luna", apply_patch_tool_type: null, use_responses_lite: false, experimental_supported_tools: [], context_window: 272000 });
  expect(original.tool_mode).toBe("code_mode_only");
  expect(CODEX_TOOL_PROFILE_OVERRIDES).toEqual(["agents.enabled=false", "features.goals=false", "tools.experimental_request_user_input.enabled=false"]);
});

test.each([
  { slug: "gpt-6.1-sol" },
  { tool_mode: "unexpected" },
  { use_responses_lite: false },
  { multi_agent_version: "v1" },
  { experimental_supported_tools: ["send_user_message_async", "clock", "new_tool"] },
  { experimental_supported_tools: ["clock", "clock"] },
])("rejects changed or unverified model metadata: %j", (change) => {
  expect(() => prepareCodexToolModel({ ...metadata(), ...change }, "codex-cli 0.164.0")).toThrow("verified tool profile");
});

test("rejects an unverified CLI version", () => {
  expect(() => prepareCodexToolModel(metadata(), "codex-cli 0.165.0")).toThrow("verified tool profile");
});
