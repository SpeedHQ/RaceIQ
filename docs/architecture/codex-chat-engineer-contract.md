# Codex Chat and Setup Engineer Contract

Status: implementation contract, 2026-11-02. This document is shared dependency
for backend and UI work. Both tracks must implement the behavior below; neither
may define its own provider, history, or safety semantics.

## Shared behavior

- Provider ID remains `codex`. Codex uses the supervised, isolated app-server
  runtime and ChatGPT account; it never consumes an API key or falls back to a
  billable provider.
- Chat and Setup Engineer retain independent provider/model choices. Existing
  non-Codex choices and defaults stay unchanged. Experiment focus `car` uses
  Setup Engineer settings; focus `driver` uses AI Chat settings.
- Chat requests include the canonical RaceIQ thread history and current system
  prompt. Assistant deltas use the existing UI-message stream; persisted user
  and assistant messages remain readable by current history, reconnect, export,
  and clear flows. A cancelled/failed turn cannot be stored as completed.
- Codex receives only explicitly registered RaceIQ tools. Lap and comparison
  chat tools are read-only. On experiment focus `car`, only the engineer gets
  engineer tools including `apply_changes`; on `driver`, only the coach gets
  coach tools including `record_drill`. Role checks happen in backend dispatch
  as well as tool selection.
- Existing `RequestContext`, active-branch evidence, version-head check,
  explicit post-proposal driver confirmation, and domain validation remain
  authoritative. A model-supplied `driverConfirmed` boolean is never authority.
  Tool calls are deduplicated within a live turn; all mutations must also use
  existing durable domain action/idempotency guards before being exposed.
- Each feature carries configured model, reasoning effort, and requested output
  budget. Codex currently reports output-cap support as false: retain requested
  value for diagnostics, never claim it was enforced. Chat and setup usage is
  nullable; unknown counts and cost stay unknown. Never display subscription
  cost as USD.
- Usage/status metadata includes provider, model, runtime, requested/effective
  budget, input/cache/output/reasoning tokens when available, latency, first
  content, tool calls, and completion/error state. Existing unsupported-cap and
  usage-limit errors remain actionable and visible.

## Backend plan

1. Extend Codex runtime input with an explicit role and a per-turn tool registry
   whose schemas and access labels are backend-owned. Keep CLI feature/MCP/shell
   isolation checks intact. Reject mismatched role, thread, turn, schema, or
   tool-access claims.
2. Add Codex text-stream adapters for lap chat, comparison chat, and experiment
   chat. Reuse existing system prompts, memory/thread IDs, `RequestContext`,
   resume registry, and save/error/cancellation paths; do not fork history into
   a Codex-only store.
3. For experiment focus, resolve `car` to `autoTuneProvider/autoTuneModel` and
   `driver` to `chatProvider/chatModel`, with the existing chat provider as the
   legacy fallback when no Setup Engineer provider is configured. Apply each
   feature's own reasoning and output budget.
4. Build tool schemas from the existing Mastra tools and invoke those tools with
   the same request context and active-branch mutation ledger used by Mastra.
   Expose only the selected agent's tools. Ensure retries, replay, cancellation,
   and reconnect cannot duplicate setup writes or driver drills.
5. Add focused runtime, route, persistence, tool authorization, settings
   migration, and cancellation tests. Exercise authenticated Codex via the
   actual endpoints after deterministic fake app-server tests pass.

## UI plan

1. Enable Codex in AI Chat and Setup Engineer provider pickers only when account
   discovery is ready; reuse the verified account/model catalog and existing
   missing-login guidance. Keep API-key inputs hidden and unchanged for other
   providers.
2. Show each section's provider/model and configured output budget separately.
   Display unsupported Codex output caps and nullable usage accurately; never
   imply configured budget is an enforced Codex limit.
3. Keep current chat streaming, reconnect, history, cancellation, and setup
   focus controls. Preserve existing provider selection and chat content when
   toggling Codex. Localize every new string across supported locales.
4. Add browser tests for provider selection, focus-to-provider mapping, stream
   reconnect, usage unknown/known values, usage-limit errors, and guarded setup
   tool outcomes. Native app-server verification remains a separate acceptance
   gate.

## Acceptance

- A Codex ChatGPT account can use lap chat and comparison chat with grounded,
  read-only telemetry tools; history survives reload and stream reconnect.
- Focus switching selects the matching configured provider/model and retains
  one canonical experiment conversation. Engineer mutations require explicit
  driver confirmation and remain exactly-once under retry/reconnect.
- Gemini/OpenAI/Anthropic/local-compatible paths and their saved settings still
  work. Unsupported Codex cap and missing usage remain explicit.
- Focused backend/UI tests, full `bun run typecheck`, lint, and changelog checks
  pass. Real authenticated smoke evidence and any unresolved platform test gaps
  are recorded in `docs/project-status/macos-desktop.md`.
