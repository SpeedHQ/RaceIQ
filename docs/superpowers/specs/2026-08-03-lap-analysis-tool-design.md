# Lap Analysis Retrieval Tool

## Goal

Move cached lap-analysis context out of chat system prompts and into an explicit, visible read-only tool call so agents ground lap-specific advice in retrieved analysis rather than guessing.

## Scope

Create `get_lap_analysis` as a Mastra tool:

- Input: `{ lapId: positive integer }`.
- Success: return the cached lap analysis parsed as structured data, with lap ID and model metadata.
- Missing/invalid analysis: return a clear unavailable result; never fabricate analysis.
- Read-only: no lap, setup, version, or driver mutations.

Register it on Lap Chat, Compare Chat, and Compare Engineer. Lap Analyst generates the analysis itself from telemetry and does not retrieve its own in-progress result.

## Prompt and display behavior

- Remove cached single-lap analysis from `buildChatSystemPrompt()` for Lap Chat.
- Remove cached Lap A/Lap B analyses from `buildCompareChatSystemPrompt()` for Compare Chat.
- Do not add a hidden fallback injection path.
- Tool execution must remain part of the AI SDK/Mastra stream so assistant-ui receives and displays the tool-result part in chat.
- Tool output should contain both structured data for the model and a readable representation for the visible tool-result renderer.

## Grounding rules

Update agent instructions:

- Lap Chat must call `get_lap_analysis` before lap-specific diagnosis or setup recommendations.
- Compare Chat must call it for both compared laps before comparison-specific advice.
- Compare Engineer must call it when prior lap analysis is relevant before producing structured recommendations.
- If the tool reports no analysis, the agent must state that limitation and avoid claiming lap-specific findings.

## Data flow

1. Chat route loads lap IDs and telemetry context needed for normal chat framing, but does not load cached analysis into the system prompt.
2. Agent calls `get_lap_analysis` with one lap ID per lookup.
3. Mastra emits the tool call and result through the existing UI-message stream.
4. assistant-ui renders the tool result and the agent continues with grounded prose or structured output.

## Error handling

Malformed cached JSON returns an unavailable/error result rather than throwing or exposing invalid data. Missing rows return `available: false`. Tool failures must be visible to the agent and must prevent confident lap-specific recommendations.

## Verification

- Unit-test found, missing, and malformed analysis results.
- Test that Lap Chat and Compare Chat prompts no longer contain cached analysis payloads.
- Test tool registration on all three consuming agents and assert no mutation tools are added.
- Smoke Lap Chat with one tool call and Compare Chat with two tool calls; verify tool-result parts are present and visible before the final response.
- Smoke Compare Engineer structured analysis with prior-analysis lookups and valid output.
