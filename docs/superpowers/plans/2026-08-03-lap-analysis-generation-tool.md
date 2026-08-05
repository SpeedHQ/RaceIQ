# Lap Analysis Generation Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing persisted lap-analysis generation flow as a Mastra tool without creating a second analysis implementation.

**Architecture:** Extract analysis preparation, provider execution, schema validation, and persistence from `POST /api/laps/:id/analyse` into `server/ai/generate-lap-analysis.ts`. The HTTP route keeps its NDJSON heartbeat adapter; `generate_lap_analysis` calls the shared service directly. Retrieval remains preferred by agents; generation is fallback context acquisition.

**Tech Stack:** Bun, TypeScript, Hono, Mastra `createTool`, Zod, Drizzle/SQLite, AI SDK providers.

## Global Constraints

- Reuse valid cached analysis unless `regenerate: true`.
- Never save malformed or schema-invalid output.
- Preserve existing `/api/laps/:id/analyse` response and HTTP error behavior.
- Register generation on Lap Chat, Compare Chat, and Compare Engineer only; Lap Analyst remains the generator and must not recurse.
- Tool results must remain in the existing streamed UI-message path.
- Do not expose setup/version mutation tools to comparison agents.

---

### Task 1: Extract shared generation service

**Files:**
- Create: `server/ai/generate-lap-analysis.ts`
- Modify: `server/routes/lap-routes.ts:380-616`
- Test: `test/generate-lap-analysis.test.ts`

**Interfaces:**
- Produces `generateLapAnalysis(lapId: number, options?: { regenerate?: boolean }): Promise<LapAnalysisResult>`.
- `LapAnalysisResult` includes `{ analysis: string | null; cached: boolean; usage?: AnalysisUsage; cornerFracs: CornerFraction[]; hasTune: boolean; error?: string }`.
- The service owns lap validation, context construction, provider setup, `lapAnalystAgent.generate`, `extractJson`, `getAnalystJsonSchema`, and `saveAnalysis`.

- [ ] **Step 1: Write failing service tests**

Cover these exact contracts:

```ts
test("returns valid cached analysis without generating", async () => {
  const result = await generateLapAnalysis(2);
  expect(result.cached).toBe(true);
  expect(result.analysis).toBeTruthy();
});

test("reports missing lap as an error result", async () => {
  const result = await generateLapAnalysis(999999);
  expect(result.analysis).toBeNull();
  expect(result.error).toContain("Lap not found");
});
```

Use dependency seams in the service for model generation and persistence so malformed output, schema-invalid output, explicit regeneration, and failed regeneration can be tested without a live model. Assert failed regeneration leaves the prior valid cache untouched.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bun test test/generate-lap-analysis.test.ts`

Expected: FAIL because service and test seams do not exist.

- [ ] **Step 3: Implement service with the existing route behavior**

Move the route's current preparation logic into the service. Keep one generation call:

```ts
const result = await lapAnalystAgent.generate(prompt, existingGenerationOptions);
const rawText = extractJson(result.text);
const parsed = parseAnalystOutput(rawText);
if (!parsed.success) throw new Error("Analyst output failed schema validation");
await saveAnalysis(lapId, JSON.stringify(parsed.data), usage);
```

Use the existing `parseAnalystOutput`, `getAnalystJsonSchema()`, and `AnalysisUsage` types. Check valid cache before provider setup. On `regenerate: true`, only replace the cache after extraction and schema validation succeed.

- [ ] **Step 4: Make the HTTP route a transport adapter**

Preserve its ping stream and response events, but call `generateLapAnalysis(id, { regenerate })` from the stream body. Return the same JSON payload and existing error statuses. Keep `cacheOnly` behavior by checking cache without invoking generation.

- [ ] **Step 5: Run service tests**

Run: `bun test test/generate-lap-analysis.test.ts`

Expected: all cache, generation, validation, and persistence tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/ai/generate-lap-analysis.ts server/routes/lap-routes.ts test/generate-lap-analysis.test.ts
git commit -m "refactor: share lap analysis generation flow"
```

### Task 2: Add generation tool and agent grounding

**Files:**
- Create or modify: `mastra/tools/lap-analysis.ts`
- Modify: `mastra/agents/lap-chat.ts`
- Modify: `mastra/agents/compare-chat.ts`
- Modify: `mastra/agents/compare-engineer.ts`
- Test: `test/lap-analysis-tool.test.ts`
- Test: `test/compare-engineer-tools.test.ts`

**Interfaces:**
- Produces `getGenerateLapAnalysisTool` with input `{ lapId: number; regenerate?: boolean }` and output `{ available: boolean; lapId: number; analysis?: unknown; readable: string; cached: boolean; usage?: AnalysisUsage; error?: string }`.
- Consumes `generateLapAnalysis` from Task 1.

- [ ] **Step 1: Write failing tool and registration tests**

Assert the tool returns cached structured output, reports generation errors without inventing output, and is registered on all three consumers. Assert `lapAnalystAgent` does not expose it.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test test/lap-analysis-tool.test.ts test/compare-engineer-tools.test.ts`

Expected: FAIL because generation tool and registrations are absent.

- [ ] **Step 3: Implement `generate_lap_analysis`**

Call `generateLapAnalysis(input.lapId, { regenerate: input.regenerate })`. Return `available: true` only when parsed analysis exists. Format `readable` from the same JSON value returned by `get_lap_analysis`, preserving visible tool output and model context.

- [ ] **Step 4: Register and update instructions**

Add the tool beside `getLapAnalysisTool` to all three agents. Update instructions to use `get_lap_analysis` first, then `generate_lap_analysis` only when retrieval reports unavailable. Require explicit limitation language when both fail. Do not register on Lap Analyst.

- [ ] **Step 5: Run focused tool tests**

Run: `bun test test/lap-analysis-tool.test.ts test/compare-engineer-tools.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add mastra/tools/lap-analysis.ts mastra/agents/lap-chat.ts mastra/agents/compare-chat.ts mastra/agents/compare-engineer.ts test/lap-analysis-tool.test.ts test/compare-engineer-tools.test.ts
git commit -m "feat: add lap analysis generation tool"
```

### Task 3: Verify parity and streamed behavior

**Files:**
- Modify if needed: `test/generate-lap-analysis.test.ts`
- Modify if needed: `test/lap-analysis-tool.test.ts`
- No production changes unless verification exposes a real defect.

**Interfaces:**
- Verifies the HTTP route and tool consume the same `generateLapAnalysis` service.

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
bun test test/generate-lap-analysis.test.ts test/lap-analysis-tool.test.ts test/compare-engineer-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Smoke cache reuse and generation endpoint**

Call `POST /api/laps/2/analyse?cacheOnly=true` and confirm the result matches the cached service result. With a configured provider, call `generate_lap_analysis` and confirm the result includes analysis, cache status, and usage without a second generation when cache is valid.

- [ ] **Step 3: Smoke streamed tool output**

Send Lap Chat, Compare Chat, and Compare Engineer requests through the existing stream transport. Confirm `tool-input-start`, tool input, tool result, and final assistant output are emitted in order. If the local model is unavailable, record that limitation and validate registration plus direct tool execution instead.

- [ ] **Step 4: Run formatting and changed-file diagnostics**

Run `bunx prettier --check` on changed TypeScript files and `git diff --check`. Do not broaden fixes to unrelated pre-existing diagnostics.

- [ ] **Step 5: Commit verification-only fixes if required**

```bash
git add test server mastra
 git commit -m "test: verify lap analysis generation parity"
```
