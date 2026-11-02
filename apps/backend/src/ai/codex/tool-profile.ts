/**
 * Exact profile tested with Codex CLI 0.164.0 and Luna. This only prepares
 * metadata and process overrides; callers must still verify authentication,
 * feature/MCP inventories, thread identity and every tool request.
 */
export const CODEX_TOOL_PROFILE_OVERRIDES = [
  "agents.enabled=false",
  "features.goals=false",
  "tools.experimental_request_user_input.enabled=false",
] as const;

export function prepareCodexToolModel(model: Record<string, unknown>, runtimeVersion: string): Record<string, unknown> {
  const tools = model.experimental_supported_tools;
  if (
    runtimeVersion !== "codex-cli 0.164.0" ||
    model.slug !== "gpt-6-luna" ||
    model.tool_mode !== "code_mode_only" ||
    model.use_responses_lite !== true ||
    model.multi_agent_version !== "v2" ||
    !Array.isArray(tools) ||
    tools.length !== 2 ||
    !tools.includes("send_user_message_async") ||
    !tools.includes("clock")
  ) throw new Error("Codex model metadata does not match the verified tool profile.");

  // CLI's tool-mode metadata otherwise suppresses app-server dynamic tools.
  // The exact replacement was validated against local negative-call probes
  // and an authenticated synthetic Luna tool call; no auth data is copied.
  const { tool_mode: _toolMode, ...rest } = model;
  return { ...rest, apply_patch_tool_type: null, use_responses_lite: false, experimental_supported_tools: [] };
}
