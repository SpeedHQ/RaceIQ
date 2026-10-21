# UI: sparse split startup migration

Contract: [shared boundary and acceptance](sparse-split-migration-contract.md). Backend: [parallel backend plan](sparse-split-migration-backend-plan.md).

## Scope and tasks

Own localized confirmation/progress UI, query hooks, and root mounting. Preserve incumbent Dialog/Button design and recording-folder migration precedence. Centered consent for startup unsplit sessions, then non-modal bottom-right progress and terminal result; explicit Close on success, visible error/retry, no fake completion. Use authenticated query enablement and production endpoints in contract. Poll while running; refresh session/lap consumers on completion. Do not gate or prompt for current-run imports.

## Edge handling

Zero startup sessions hides prompt (AC4). Layout migration takes precedence; wait for completion/dismissal before split UI (AC4). Reload restores current operation, errors remain visible and retryable, duplicate submissions disabled (AC5). Long translated copy and narrow viewport use existing responsive dialog sizing. Preserve keyboard access when transition switches to non-modal (AC2). Do not present unsupported source data as migratable.

## Verification

Reuse Playwright fresh-install setup for actual normal seed → backend startup → centered consent → click → non-modal progress → success → Close → reload hidden (AC1/2/5). Import through actual backend while consent waits; ensure import needs no extra modal (AC3). Verify empty and already indexed data, layout precedence, controlled backend failure/retry, duplicate action, mobile viewport and dialog accessibility (AC4/5). Main agent owns real integration execution and `bun run typecheck`; fixtures may aid isolated UI development but never replace production integration proof.
