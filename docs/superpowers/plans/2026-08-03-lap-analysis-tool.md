# Lap Analysis Retrieval Tool Implementation Plan

## 1. Add tool

Create `mastra/tools/lap-analysis.ts` with a positive-integer `lapId` schema. Use `getAnalysis(lapId)`, parse JSON safely, and return `{ available, lapId, analysis, model, ... }` or an explicit unavailable/error result. Keep execution read-only and test it with mocked query results.

## 2. Register tool

Add the tool to `lap-chat`, `compare-chat`, and `compare-engineer` agent definitions. Preserve existing read-only tool surfaces; do not expose setup/version mutation tools to comparison agents.

## 3. Remove prompt injection

Update `server/ai/chat-prompt.ts`, `server/ai/compare-chat-prompt.ts`, and `server/routes/lap-routes.ts` so cached analysis is no longer loaded or passed into chat system prompts. Retain only current lap/comparison context required for normal conversation framing.

## 4. Ground agent behavior

Update Lap Chat, Compare Chat, and Compare Engineer instructions to call `get_lap_analysis` before lap-specific diagnosis or recommendations. Require both lap IDs for Compare Chat and explicit limitation handling when analysis is unavailable.

## 5. Preserve visible tool results

Keep the existing Mastra/AI SDK stream path unchanged so tool-call and tool-result parts reach assistant-ui. Add or update tool-part rendering only if focused smoke output proves the result is not visible.

## 6. Test and smoke

Add focused unit tests for tool success, missing rows, malformed JSON, registration, and prompt absence. Run focused tests plus client typecheck. Exercise Lap Chat, Compare Chat, and Compare Engineer API flows and inspect streamed events for tool calls/results before final assistant output.
