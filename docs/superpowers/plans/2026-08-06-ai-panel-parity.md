# AI Panel Parity Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore RaceIQ PR #213 AI behavior across Experiments, Analyse, and Compare on the current folder-cleanup branch.

**Architecture:** Selectively port PR #213 contracts into current route/component boundaries. Shared AI services own provider resolution, validated analysis generation/retrieval, persisted chat lineage, and detached-run recovery; client panels remain adapters. Do not cherry-pick the PR wholesale because this branch reorganized and removed unrelated files.

**Tech Stack:** Bun, TypeScript, Hono, Mastra, AI SDK v7, React, TanStack Query/Router, Zod, Playwright.

## Global Constraints

- Preserve current settings-dialog, telemetry, and folder-cleanup work.
- Restore full PR #213 parity, not a reduced or mocked implementation.
- Cached analysis is usable only after schema validation.
- Failed generation must not overwrite valid prior analysis.
- Non-generating preflight must return JSON errors with correct HTTP status.
- No dynamic imports; use static imports and dependency seams.
- Existing unrelated working-tree changes remain untouched.
- Run focused tests before broader typecheck/build/browser verification.

---

### Task 1: Inventory current-vs-PR AI contracts

**Files:**
- Read: `client/src/components/ai/AiPanel.tsx`
- Read: `client/src/components/ai-chat/ChatPanel.tsx`
- Read: `client/src/components/comparison/CompareAiPanel.tsx`
- Read: `client/src/components/tunes/TuneSetupChat.tsx`
- Read: `server/routes/laps/analysis-routes.ts`
- Read: `server/routes/laps/chat-routes.ts`
- Read: `server/routes/laps/comparison-routes.ts`
- Read: `server/routes/tune-chat-routes.ts`
- Read: `server/ai/generate-lap-analysis.ts`
- Read: `mastra/tools/lap-analysis.ts`
- Read: `mastra/tools/compare-analysis.ts`
- Read: `test/ai/chat/*.test.ts`
- Read: `test/ai/tools/*.test.ts`

**Interfaces:**
- Consumes: PR #213 at `refs/remotes/origin/pr-213` and current branch implementation.
- Produces: a concrete gap ledger mapping each parity behavior to current file, missing contract, and regression test.

- [ ] **Step 1: Compare PR and current implementations**

```bash
git diff HEAD..origin/pr-213 -- client/src/components/ai client/src/components/ai-chat client/src/components/comparison client/src/components/tunes server/ai server/routes/laps server/routes/tune-chat-routes.ts mastra/agents mastra/tools test/ai test/client test/experiments
```

Record only behavior-affecting differences: API shape, message persistence, generation lifecycle, provider binding, experiment branch visibility/deletion, and history export.

- [ ] **Step 2: Run existing focused tests before edits**

```bash
bun test test/ai test/client/resumable-chat.test.ts test/experiments test/compare-card-background.test.ts --timeout 30000
```

Expected: baseline results recorded; failures classified as pre-existing or parity regressions.

- [ ] **Step 3: Commit the gap ledger only if repository convention requires it**

Do not create a new report file. Keep the ledger in the implementation plan/task notes so no unrequested documentation is added.

### Task 2: Restore shared analysis generation and retrieval contracts

**Files:**
- Modify: `server/ai/generate-lap-analysis.ts`
- Modify: `server/routes/laps/analysis-routes.ts`
- Modify: `server/ai/analyst-prompt.ts`
- Modify: `mastra/tools/lap-analysis.ts`
- Modify: `mastra/tools/compare-analysis.ts`
- Modify: `server/ai/agents.ts`
- Modify: `mastra/agents/lap-analyst.ts`
- Test: `test/generate-lap-analysis.test.ts`
- Test: `test/lap-analysis-tool.test.ts`
- Test: `test/lap-analysis-generation-tool.test.ts`
- Test: `test/compare-engineer-tools.test.ts`
- Test: `test/analysis-provider-binding.test.ts`

**Interfaces:**
- Consumes: current `AnalystOutputSchema`, analysis DB queries, `resolveAi`, game sector helpers, and existing route result types.
- Produces: `generateLapAnalysis(lapId, options)` with validated cache reuse, preflight mode, regeneration mode, native/arbitrary sector prompt context, and stable error/result fields; exact `get_lap_analysis` and `generate_lap_analysis` tool contracts.

- [ ] **Step 1: Add failing regression coverage**

Cover these observable contracts:

```ts
// valid cache returns cached analysis without model generation
// null, arrays, malformed JSON, and schema-invalid cache rows return unavailable
// missing lap/provider failure during regenerate preflight returns JSON error status
// failed regeneration preserves the previous valid cache
// native iRacing sectors and six-sector prompts preserve all source boundaries
// Lap Chat and Compare Chat expose snake-case retrieval/generation tools
// Lap Analyst exposes retrieval but not generation
```

- [ ] **Step 2: Run focused tests and confirm failures**

```bash
bun test test/generate-lap-analysis.test.ts test/lap-analysis-tool.test.ts test/lap-analysis-generation-tool.test.ts test/compare-engineer-tools.test.ts test/analysis-provider-binding.test.ts --timeout 30000
```

Expected: each newly asserted missing contract fails before implementation.

- [ ] **Step 3: Implement one shared generation path**

The service must:

1. Load and validate lap/telemetry/game context.
2. Return validated cached analysis unless regeneration is requested.
3. Run non-generating preflight before opening an NDJSON response.
4. Resolve the request-scoped provider/model through `resolveAi("analysis", requestContext)`.
5. Build native sector timelines when the adapter provides them; otherwise use curated track boundaries.
6. Parse JSON and `AnalystOutputSchema.safeParse` before persistence.
7. Persist only successful schema-valid results.
8. Return structured errors without inventing analysis.

- [ ] **Step 4: Implement exact Mastra tool registration**

Register `get_lap_analysis` and `generate_lap_analysis` where PR #213 requires them. Keep Lap Analyst generation-free and preserve Compare Engineer's existing setup/version tool surface.

- [ ] **Step 5: Run focused tests to green**

```bash
bun test test/generate-lap-analysis.test.ts test/lap-analysis-tool.test.ts test/lap-analysis-generation-tool.test.ts test/compare-engineer-tools.test.ts test/analysis-provider-binding.test.ts test/ai-track-context.test.ts --timeout 30000
```

Expected: PASS with zero failures.

### Task 3: Restore chat persistence, lineage, resume, regeneration, and export

**Files:**
- Modify: `server/ai/chat-agent.ts`
- Modify: `server/ai/chat-message-context.ts`
- Modify: `server/ai/chat-run-registry.ts`
- Modify: `server/routes/laps/chat-routes.ts`
- Modify: `server/routes/laps/comparison-routes.ts`
- Modify: `server/routes/tune-chat-routes.ts`
- Modify: `server/routes/chats-routes.ts`
- Modify: `client/src/components/ai-chat/ChatPanel.tsx`
- Modify: `client/src/components/ai-chat/chat-runtime.tsx`
- Modify: `client/src/components/ai-chat/resumable-chat.ts`
- Test: `test/ai/chat/chat-regenerate.test.ts`
- Test: `test/ai/chat/chat-export.test.ts`
- Test: `test/ai/chat/chat-generations.test.ts`
- Test: `test/ai/chat/compare-chat-message-context.test.ts`
- Test: `test/client/resumable-chat.test.ts`

**Interfaces:**
- Consumes: shared thread IDs (`chatThreadId`, `compareChatThreadId`, `tuneSessionThreadId`), current Mastra memory adapter, and AI SDK UI-message conversion.
- Produces: canonical persisted history with tool/reasoning parts, generation list/view/fork behavior, detached-run replay/status/cancel endpoints, safe regeneration truncation, and compare JSON export.

- [ ] **Step 1: Add failing history-contract tests**

Assert that persisted history:

```ts
// keeps system context out of driver-visible history
// preserves user, assistant, tool-call, tool-result, and reasoning parts
// retains messages before selected user message and deletes response/later lineage
// rejects unknown and non-user regeneration IDs
// preserves generation order and active-generation selection
// exports complete compare history as JSON
// reconnects to active detached runs and does not duplicate messages
```

- [ ] **Step 2: Run chat tests and confirm failures**

```bash
bun test test/ai/chat/chat-regenerate.test.ts test/ai/chat/chat-export.test.ts test/ai/chat/chat-generations.test.ts test/ai/chat/compare-chat-message-context.test.ts test/client/resumable-chat.test.ts --timeout 30000
```

- [ ] **Step 3: Implement server-side canonical history and lineage**

Use one shared sanitization/conversion path for all three chat surfaces. Regeneration must validate the selected message belongs to the active thread and is a user message, truncate only that generation's later messages, and return the prompt needed to resubmit.

- [ ] **Step 4: Implement client resume/regeneration behavior**

`ChatPanel` must load generation metadata before choosing a thread, display read-only historical generations, reconnect active runs through the shared resumable storage key, and invalidate the correct TanStack Query keys after clear/regenerate/fork.

- [ ] **Step 5: Add compare export control and verify chat tests**

Expose complete persisted Compare history from the panel header and run:

```bash
bun test test/ai/chat/chat-regenerate.test.ts test/ai/chat/chat-export.test.ts test/ai/chat/chat-generations.test.ts test/ai/chat/compare-chat-message-context.test.ts test/client/resumable-chat.test.ts --timeout 30000
```

Expected: PASS with zero failures.

### Task 4: Restore client panel behavior and experiment visibility/actions

**Files:**
- Modify: `client/src/components/ai/AiPanel.tsx`
- Modify: `client/src/components/comparison/CompareAiPanel.tsx`
- Modify: `client/src/components/ai-chat/LapAnalysisText.tsx`
- Modify: `client/src/components/tunes/ExperimentList.tsx`
- Modify: `client/src/components/tunes/ExperimentWorkspace.tsx`
- Modify: `client/src/components/tunes/TuneSetupChat.tsx`
- Modify: `server/routes/experiments/lap-routes.ts`
- Modify: `server/routes/experiments/version-routes.ts`
- Modify: `server/db/experiment-queries.ts`
- Test: `test/experiments/experiments.test.ts`
- Test: `test/experiments/setup-engineer-confirmation.test.ts`
- Test: `test/experiments/setup-engineer-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 service and route contracts.
- Produces: end-to-end panel adapters for cached/generated analysis, chat state, regeneration/delete actions, setup-seeded `v1` visibility, and explicit experiment branch deletion.

- [ ] **Step 1: Add failing UI/API contract tests**

Cover:

```ts
// Analyse panel loads validated cache and exposes retry/regenerate/delete
// Analyse regeneration clears the intended chat lineage only
// Compare panel enables chat after both lap analyses are available
// Compare panel exports complete history and preserves both analysis summaries
// experiment list includes setup-seeded v1
// deleting a branch removes descendants and posts the canonical chat acknowledgement
// TuneSetupChat invalidates experiment/version/history queries after a tool turn
```

- [ ] **Step 2: Run targeted tests and confirm failures**

```bash
bun test test/experiments/experiments.test.ts test/experiments/setup-engineer-confirmation.test.ts test/experiments/setup-engineer-tools.test.ts test/compare-card-background.test.ts --timeout 30000
```

- [ ] **Step 3: Port panel state transitions without changing layout ownership**

Keep current components and styling. Wire them to the shared result/status contracts. On lap change reset only lap-scoped state; on regeneration clear the correct chat lineage before starting; on failed generation retain prior analysis.

- [ ] **Step 4: Restore experiment list/delete semantics**

Include setup-seeded `v1` in the list query/result, add explicit delete action with confirmation, remove the selected branch and descendants server-side, and invalidate list/version/history queries after success.

- [ ] **Step 5: Verify targeted tests**

```bash
bun test test/experiments/experiments.test.ts test/experiments/setup-engineer-confirmation.test.ts test/experiments/setup-engineer-tools.test.ts test/compare-card-background.test.ts --timeout 30000
```

Expected: PASS with zero failures.

### Task 5: Restore provider migration and cross-surface consistency

**Files:**
- Modify: `server/ai/ai-runtime.ts`
- Modify: `server/ai/model-provider.ts`
- Modify: `server/ai/provider-adapters.ts`
- Modify: `server/runtime/config/settings.ts`
- Modify: `client/src/lib/is-ai-configured.ts`
- Modify: `client/src/components/settings/AiSection.tsx`
- Modify: `test/ai/ai-configured.test.ts`
- Test: `test/analysis-provider-binding.test.ts`

**Interfaces:**
- Consumes: current settings schema, keystore, provider adapters, and panel configuration helpers.
- Produces: consistent Gemini/OpenAI/Local readiness and request-scoped model selection; stale unsupported selections migrate to unconfigured pairs before schema validation while preserving unrelated settings/budgets.

- [ ] **Step 1: Add provider migration and binding regression tests**

Assert unsupported persisted provider/model values become unconfigured, valid unrelated settings survive, and analysis/chat/experiment/compare all select the same request-scoped provider credentials.

- [ ] **Step 2: Run focused provider tests**

```bash
bun test test/ai/ai-configured.test.ts test/analysis-provider-binding.test.ts --timeout 30000
```

- [ ] **Step 3: Implement migration and readiness consistently**

Keep provider choices limited to Gemini, OpenAI, and Local. Do not silently fall back to another provider or model. Use static imports and request context rather than dynamic loading.

- [ ] **Step 4: Re-run provider tests**

```bash
bun test test/ai/ai-configured.test.ts test/analysis-provider-binding.test.ts test/generate-lap-analysis.test.ts --timeout 30000
```

Expected: PASS with zero failures.

### Task 6: Full verification and browser smoke coverage

**Files:**
- Test: `playwright/tests/**` existing AI/experiment routes where applicable
- Modify only if a missing observable regression test is required.

**Interfaces:**
- Consumes: all restored server/client contracts.
- Produces: evidence that Experiments, Analyse, and Compare work end to end.

- [ ] **Step 1: Run complete focused AI suite**

```bash
bun test test/ai test/client/resumable-chat.test.ts test/experiments test/compare-card-background.test.ts --timeout 30000
```

- [ ] **Step 2: Run i18n and TypeScript checks**

```bash
bun run --cwd client i18n:compile
bunx tsc --project tsconfig.json --noEmit --pretty false --incremental false
```

- [ ] **Step 3: Run production client build**

```bash
bun run build
```

Expected: build completes; any unrelated pre-existing native binding warning is recorded without masking changed-file failures.

- [ ] **Step 4: Run browser smoke flows**

Start the normal development server, then exercise seeded data:

1. Open an experiment, confirm `v1` is visible, send a setup prompt, reload, inspect persisted tool/reasoning history, and delete a branch.
2. Open Analyse, load cached analysis, generate when absent, regenerate, open display/setup tabs, and verify delete/retry behavior.
3. Open Compare, generate both lap analyses and input analysis, send chat, reload/resume, regenerate a response, and export history JSON.

Capture route, HTTP status, and visible result for each flow.

- [ ] **Step 5: Review diff boundaries**

```bash
git diff --check
git status --short
```

Confirm only parity files plus the pre-existing `client/src/components/track/TrackDetailRoute.tsx` worktree change are present.

### Task 7: Store completion context

**Files:**
- None.

- [ ] **Step 1: Store durable project memory**

```bash
icm store -t context-raceiq -c "Restored PR #213 AI parity across experiment setup chat, lap Analyse, and Compare analysis/chat; verified focused tests, typecheck/build, and browser smoke flows. Preserved folder-cleanup settings changes." -i high -k "AI panel,experiments,analyse,compare,PR213"
```
