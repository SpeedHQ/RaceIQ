# Race Result Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full chronological Start → pit events → Finish ledger inside expanded session rows.

**Architecture:** Fetch the existing session-result endpoint only for expanded rows through a React Query helper. Keep ledger rendering isolated in `RaceResultLedger`, with deterministic node data and responsive horizontal overflow. Mount it above the existing lap table in both mobile and desktop expanded views.

**Tech Stack:** React, TypeScript, TanStack React Query, existing RPC client, Tailwind utility classes, Bun test/build.

## Global Constraints

- No server schema or route changes.
- Do not trigger writes from the client; use existing result endpoint.
- Render Start and Finish even when no pit events exist.
- Omit null optional event details.
- Preserve existing lap table interactions.
- Use shared UI primitives and existing design tokens.

---

### Task 1: Add typed result query helper

**Files:**
- Modify: `client/src/hooks/queries.ts`
- Test: `client/src/hooks/queries.test.ts` if existing hook tests are available; otherwise verify through typecheck and component behavior.

**Interfaces:**
- Produces `useSessionResult(sessionId: number | null | undefined, gameId: GameId | null | undefined, enabled?: boolean)` returning the existing result payload, loading, and error state.

- [ ] Add query key and helper using `client.api.sessions[":id"].result.$get({ param, query: { gameId } })`.
- [ ] Gate request on both IDs and `enabled`.
- [ ] Preserve HTTP errors as query errors and parse successful JSON.
- [ ] Run the relevant hook/typecheck command.

### Task 2: Build deterministic horizontal ledger

**Files:**
- Create: `client/src/components/race-results/RaceResultLedger.tsx`

**Interfaces:**
- Consumes `{ sessionId, gameId, enabled }`.
- Produces loading, error, unavailable, empty-event, and full Start → event → Finish render states.

- [ ] Define local node model for `start`, `pit`, and `finish` nodes.
- [ ] Use `useSessionResult` and map persisted events in sequence order.
- [ ] Render connected nodes in an overflow-x container.
- [ ] Render optional lap, duration, fuel, and tyre details only when non-null.
- [ ] Use accessible labels and existing app surface/border/text tokens.

### Task 3: Mount ledger in expanded session rows

**Files:**
- Modify: `client/src/components/SessionsPage.tsx`

**Interfaces:**
- Existing row expansion passes session ID and game ID to `RaceResultLedger`.

- [ ] Import `RaceResultLedger`.
- [ ] Render it above `SessionLapTable` in mobile expanded cards and desktop expanded table rows.
- [ ] Keep ledger mounted only for expanded rows and preserve existing event propagation behavior.
- [ ] Keep lap table visible when result query is loading, unavailable, or errors.

### Task 4: Add deterministic ledger tests

**Files:**
- Create or modify: existing client component test location discovered during implementation.

- [ ] Add coverage for Start → pit → Finish ordering.
- [ ] Add coverage for zero pit events.
- [ ] Add coverage that null optional details do not render as zero or placeholder values.
- [ ] Run focused tests and confirm failure before implementation where test infrastructure supports component tests.

### Task 5: Verify and push

**Files:**
- No additional source files expected.

- [ ] Run `bun run build`.
- [ ] Run focused tests and existing race-result tests.
- [ ] Browser-check expanded desktop and narrow/mobile session rows.
- [ ] Run `git diff --check`.
- [ ] Commit and push `feat/issue-181-race-results`.
