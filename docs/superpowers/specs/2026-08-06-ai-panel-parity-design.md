# AI Panel Parity Restoration

Date: 2026-08-06
Reference: RaceIQ pull request #213

## Goal

Restore complete PR #213 AI behavior on the current `folder-cleanup` branch without reverting unrelated settings, telemetry, or folder-organization work.

## Scope

### Experiments

- Show setup-seeded `v1` experiment branches immediately.
- Preserve complete setup-agent chat history, including tool calls and reasoning.
- Support resumable and regenerable chat turns while preserving canonical history.
- Keep experiment branch deletion explicit and synchronize experiment lists, versions, and chat acknowledgements.
- Preserve current experiment focus and review workflows.

### Analyse

- Load only schema-valid cached lap analysis.
- Generate analysis through the shared generation path with request-scoped provider/model settings.
- Preserve streamed progress, detached-run recovery, status polling, and retry behavior.
- Regeneration must clear the intended chat lineage, retain prior cache on failure, and support native/arbitrary sector context.
- Preserve analysis display, setup recommendations, highlights, export, and delete controls.

### Compare

- Restore validated retrieval and generation for per-lap and inputs analyses.
- Preserve comparison chat persistence, tool/reasoning history, resumability, regeneration, and complete history export.
- Keep Compare Engineer tool registration and provider binding consistent with Lap Chat and Lap Analyst.
- Preserve current comparison visualizations and history navigation.

### Providers and compatibility

- Keep Gemini, OpenAI, and Local behavior consistent across analysis and chat.
- Migrate stale unsupported provider/model selections safely before validation.
- Avoid dynamic imports; resolve circular dependencies through module boundaries or dependency seams.

## Architecture

Use selective parity porting. Current routes/components remain integration boundaries; PR behavior is restored in the owning shared services and adapters:

- Shared lap-analysis generation/retrieval service owns lookup, validation, prompt context, provider resolution, generation, persistence, and result/error contracts.
- Chat run registries and persisted memory own detached-run status, replay/resume, canonical message history, generation lineage, and regeneration truncation.
- Client `ChatPanel`, `AiPanel`, `CompareAiPanel`, and `TuneSetupChat` remain thin surface adapters over those APIs.
- Experiment and compare routes retain current folder layout while exposing the complete PR contracts.

## Error handling

- Non-generating preflight returns JSON errors with correct HTTP status.
- Invalid or schema-incompatible cached analysis is unavailable and may fall back to generation.
- Generation failure never overwrites a valid prior cache.
- Failed streams clean up run state and expose actionable client errors.
- Provider configuration errors identify the affected feature without silently selecting defaults.

## Verification

- Focused server tests for lap generation, retrieval validation, provider binding, compare tools, chat regeneration/history, and experiment chat/branch behavior.
- Client typecheck, i18n compilation, production build, and targeted component tests where available.
- Browser smoke flows for Experiments setup chat, Analyse generation/regeneration/display, and Compare analysis/chat/history export.
- Existing unrelated working-tree changes remain untouched.
