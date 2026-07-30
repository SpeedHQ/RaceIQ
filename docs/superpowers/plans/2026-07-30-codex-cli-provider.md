# Codex CLI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenAI Codex CLI provider that uses the user's authenticated ChatGPT/Codex subscription instead of an OpenAI API key.

**Architecture:** Add a shared Bun subprocess adapter in `server/ai/providers.ts`. It invokes `codex exec --json --ephemeral` with stdin prompts, extracts the final agent message from JSONL events, and converts failures into actionable errors. Add `codex` to settings/provider discovery and direct AI call paths; keep API-key providers unchanged. Chat uses a one-shot UI-message stream wrapper around the CLI result.

**Tech Stack:** TypeScript, Bun.spawn, Hono, AI SDK UI-message streams, React Query, Vitest/Bun test runner.

## Global Constraints

- Codex provider MUST NOT read or set `OPENAI_API_KEY`.
- Codex provider MUST use the installed `codex` executable and authenticated CLI session.
- Missing CLI, unauthenticated CLI, timeout, non-zero exit, empty output, and malformed output MUST produce actionable errors.
- Existing Gemini, OpenAI API, and Local behavior MUST remain unchanged.
- Tests MUST use a fake executable or pure parser fixtures; no real subscription calls.

---

### Task 1: Add tested Codex CLI adapter

**Files:**
- Modify: `server/ai/providers.ts`
- Test: `test/ai-providers.test.ts` (existing provider test file if present; otherwise create)

**Interfaces:**
- Produces `runCodexCli(prompt: string, model?: string): Promise<AiResult>`.
- Produces `parseCodexJsonl(raw: string): { text: string; model: string; inputTokens: number; outputTokens: number }`.

- [ ] Write parser tests for final `agent_message`, usage metadata, blank output, malformed JSON, and unrelated progress events.
- [ ] Run focused test and verify failure before implementation.
- [ ] Implement JSONL parser that accepts final response events and ignores progress events.
- [ ] Implement `runCodexCli` with `Bun.spawn(["codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", ...(model ? ["--model", model] : []), "-"])`, prompt on stdin, 90-second timeout, stdout/stderr capture, and bounded diagnostics.
- [ ] Run focused adapter tests and verify pass.

### Task 2: Register Codex in settings and provider discovery

**Files:**
- Modify: `server/settings.ts`
- Modify: `server/ai/providers.ts`
- Modify: `server/routes/settings-routes.ts`
- Modify: `client/src/components/settings/AiSection.tsx`
- Modify: `client/src/lib/is-ai-configured.ts`
- Modify: `shared/ai/context-window.ts`
- Test: `test/settings.test.ts` and provider/config tests

**Interfaces:**
- Provider ID is the literal `codex` everywhere.
- `/api/ai-providers` returns `{ id: "codex", name: "OpenAI Codex (ChatGPT subscription)" }`.
- Settings marks Codex configured by CLI availability/auth status, not a stored key.

- [ ] Add `codex` to all provider schemas and provider unions without changing defaults.
- [ ] Add a server-side Codex status helper that runs `codex login status` and returns configured/unconfigured state without exposing credentials.
- [ ] Include Codex in provider/model response types; return no remote model list for Codex.
- [ ] Render Codex as a no-key provider with setup guidance (`codex login`) and hide API-key controls.
- [ ] Add Codex context-window fallback matching the CLI model family without inventing a limit when model is unknown.
- [ ] Add focused tests for schema acceptance, provider discovery, and configured-state behavior.

### Task 3: Wire direct AI features to Codex

**Files:**
- Modify: `server/routes/lap-routes.ts`
- Modify: `server/ai/tune-intent.ts`
- Modify: `server/ai/driver-profile-runner.ts`
- Modify: `server/ai/consult-lap-analyst.ts`
- Modify: `server/ai/chat-agent.ts`
- Modify: `mastra/model.ts` if required by shared model dispatch
- Test: corresponding focused route/provider tests

**Interfaces:**
- Every direct provider switch handles `codex` by calling `runCodexCli` and never API-key plumbing.
- Codex output must pass existing structured-output parsing/schema validation.

- [ ] Add Codex branches for lap analysis, tune intent, driver profile, and any shared provider dispatcher.
- [ ] Preserve existing model fallback values for other providers; Codex passes optional configured model or CLI default.
- [ ] Add explicit missing-auth error text naming `codex login`.
- [ ] Run focused structured-output tests and verify pass.

### Task 4: Wire chat to a Codex-backed UI stream

**Files:**
- Create: `server/ai/codex-chat-stream.ts`
- Modify: `server/routes/lap-routes.ts`
- Modify: `server/routes/tune-chat-routes.ts`
- Modify: `server/ai/chat-agent.ts` only if shared prompt formatting requires it
- Test: `test/codex-chat-stream.test.ts`

**Interfaces:**
- `createCodexChatResponse(args): Promise<Response>` accepts system prompt, user/assistant messages, thread metadata, and model; returns the same AI SDK v5 UI-message stream response shape used by assistant-ui.

- [ ] Write stream contract tests asserting start, text delta, finish, and error chunks.
- [ ] Implement one-shot CLI execution and emit the complete final answer as a UI-message stream, preserving existing route HTTP shape.
- [ ] Route `chatProvider === "codex"` through this adapter before Mastra provider setup; leave other providers unchanged.
- [ ] Add actionable CLI failure response and ensure no memory write occurs on failed turns.
- [ ] Run focused chat stream tests and verify pass.

### Task 5: Verify, document, commit, and open PR

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-codex-cli-provider-design.md` only if implementation decisions materially differ
- Modify: `CHANGELOG.md` with user-visible Unreleased entry

- [ ] Run typecheck and focused provider/settings/chat tests.
- [ ] Run app smoke check with a fake `codex` executable covering configured and unauthenticated states.
- [ ] Review diff for API-key leakage and accidental default changes.
- [ ] Commit implementation and changelog.
- [ ] Push `feat/add-gpt-subscription` and create PR with verification summary.
