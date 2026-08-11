---
name: ai-chat-mastra
description: AI insight feature expanded with Mastra-based chat, separate analysis/chat providers, macOS Keychain keystore
type: project
---

AI insight feature overhauled (2026-04-07, branch `claude/add-chat-to-insights-GGbtf`):

- **Structured analysis + chat**: AiPanel replaces the old AiAnalysisModal. Renders structured analysis cards (pace, handling, corners, braking, throttle, coaching, setup with TuneBar) plus streaming chat — all in a right sidebar panel.
- **Mastra AI framework**: `@mastra/core` Agent, `@mastra/memory` Memory with LibSQLStore at `data/chat-memory.db`, lastMessages: 50. Chat agent in `server/ai/chat-agent.ts`, prompt builder in `server/ai/chat-prompt.ts`.
- **Separate providers**: Settings has `aiProvider`/`aiModel` (for analysis) and `chatProvider`/`chatModel` (for chat). Both support Gemini, OpenAI, and Local (LM Studio/Ollama).
- **Claude CLI removed**: Only Gemini and OpenAI for structured analysis (use JSON schema enforcement). Legacy `claude-cli` setting migrated to `gemini` on load.
- **API key storage**: `server/runtime/platform/keystore.ts` uses macOS Keychain (`security` CLI) and Windows Credential Manager (PowerShell). Keys: `gemini-api-key`, `openai-api-key`, `anthropic-api-key`.
- **Mastra Studio**: `mastra/index.ts` entry point, `bun run mastra:dev` → port 4111.
- **TrackCard click → highlights**: Clicking analysis cards highlights track zones (good/warning/critical colors) on AnalyseTrackMap.

**Why:** User wanted interactive follow-up questions about lap analysis, not just one-shot structured output.

**How to apply:** When modifying AI features, be aware of the dual provider system. Analysis uses `ANALYSIS_SCHEMA` for structured JSON output. Chat uses Mastra agents with memory persistence per lap thread (`lap-{lapId}`).
