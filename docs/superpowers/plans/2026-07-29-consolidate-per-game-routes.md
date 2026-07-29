# Consolidate Per-Game Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace copied shared per-game routes with dynamic game-aware route families without changing public URLs or game-specific behavior.

**Architecture:** Add a typed client helper that maps route prefixes to registered `GameId` values and owns shared search parsing/feature metadata. Add dynamic `/$gameid` route files for shared pages and experiments, then remove only superseded copied routes; retain explicit divergent raw/setup/dashboard routes. Update navigation to use the helper and regenerate TanStack Router output.

**Tech Stack:** React 19, TanStack Router, TypeScript, Bun test, shared game adapter registry.

## Global Constraints

- Preserve `/fm23`, `/f125`, `/acc`, `/ac-evo`, and `/iracing` URLs and existing query keys.
- Unknown game IDs must be rejected or guarded; never fall back to `fm-2023`.
- Use static imports only; dynamic imports are prohibited.
- Do not edit `client/src/routeTree.gen.ts` manually.
- Keep raw, setup, dashboard, and car-detail behavior game-specific where implementations differ.

---

### Task 1: Add route helper contracts and tests

**Files:**
- Create: `client/src/lib/game-routes.ts`
- Test: `test/client-game-routes.test.ts`

**Interfaces:**
- `gameIdForRoutePrefix(prefix: string): GameId | undefined`
- `routePrefixForGameId(gameId: string): string | undefined`
- `parseOptionalNumber(value: unknown): number | undefined`
- `validateAnalyseSearch(search: Record<string, unknown>): AnalyseSearch`
- `validateSessionsSearch(search: Record<string, unknown>): SessionsSearch`
- `validateTuneSearch(search: Record<string, unknown>): TuneSearch`
- `supportsGameFeature(prefix: string, feature: GameRouteFeature): boolean`

- [ ] Write tests covering all five supported route prefixes, unknown prefixes, finite/non-finite numeric values, analysis keys (`track`, `car`, `lap`, `cursor`, `viz`), session `tab`, tune `session/lap/view`, and feature support for experiments/setups/driver.
- [ ] Run `bun test test/client-game-routes.test.ts --timeout 30000`; confirm the new tests fail before implementation.
- [ ] Implement the helper using registered adapter metadata and explicit capability metadata for features that are not part of `GameAdapter`.
- [ ] Run the focused test again and confirm it passes.

### Task 2: Add dynamic shared route families

**Files:**
- Create: `client/src/routes/$gameid/sessions.tsx`
- Create: `client/src/routes/$gameid/chats.tsx`
- Create: `client/src/routes/$gameid/analyse.tsx`
- Create: `client/src/routes/$gameid/driver.tsx`
- Create: `client/src/routes/$gameid/experiments.tsx`
- Create: `client/src/routes/$gameid/experiments.index.tsx`
- Create: `client/src/routes/$gameid/experiments.$experimentId.tsx`
- Create: `client/src/routes/$gameid/experiments.$experimentId_.review.tsx`

**Interfaces:**
- Dynamic routes consume `gameIdForRoutePrefix`, `Route.useParams()`, and the shared validators from Task 1.
- Experiment routes pass resolved `GameId` values to existing experiment components and preserve `session`, `lap`, and `view` search values.

- [ ] Implement shared sessions/chats/analyse/driver wrappers with the same full-height wrappers and validators currently used by copied routes.
- [ ] Implement experiment list/workspace/review routes with one shared navigation path and an explicit guard for setup-engineer games (`acc`, `ac-evo`, `f1-2025`).
- [ ] Ensure iRacing receives the shared sessions/chats/analyse/driver routes but not experiment routes.
- [ ] Run the route-helper tests and TypeScript diagnostics for new files.

### Task 3: Migrate callers and remove superseded copies

**Files:**
- Modify: `client/src/components/AppSidebar.tsx`
- Modify: `client/src/components/ChatsPage.tsx`
- Modify: `client/src/components/SessionsPage.tsx`
- Modify: `client/src/components/RecordedLaps.tsx`
- Modify: `client/src/components/LapList.tsx`
- Modify: `client/src/components/SessionRecap.tsx`
- Modify: `client/src/components/tunes/ExperimentList.tsx`
- Modify: `client/src/components/tunes/ExperimentWorkspace.tsx`
- Modify: related import/result navigation callers found during migration
- Delete: superseded copied `sessions.tsx`, `chats.tsx`, `analyse.tsx`, `driver.tsx`, and experiment route files under `fm23`, `f125`, `acc`, `ac-evo`, and `iracing`

- [ ] Replace hardcoded feature route-prefix arrays with the route helper/feature metadata.
- [ ] Migrate shared navigation links to `/${routePrefix}/${segment}` while retaining explicit setup/raw links.
- [ ] Update experiment navigation callbacks to target `/$gameid/experiments/...` route templates and preserve numeric IDs.
- [ ] Delete only route copies represented by the dynamic implementations; retain divergent setup/raw/dashboard files.
- [ ] Run a repository search for deleted route paths and confirm no stale imports or links remain.

### Task 4: Regenerate routes and add route integration coverage

**Files:**
- Modify: generated `client/src/routeTree.gen.ts` via the router generator
- Modify/Create: focused route test files as needed

- [ ] Run the project’s TanStack Router generation through the client toolchain, not by hand.
- [ ] Verify the generated route tree contains dynamic shared routes and retains explicit divergent routes.
- [ ] Add integration assertions for the supported dynamic route paths and experiment nested paths.
- [ ] Run focused route tests and client TypeScript/build checks.

### Task 5: Full verification and baseline reporting

**Files:**
- Modify: no source files unless verification exposes a regression
- Record: final response and ICM context memory

- [ ] Run `bun test test/client-game-routes.test.ts --timeout 30000`.
- [ ] Run `cd client && bun run build`.
- [ ] Run `bun run test`.
- [ ] Compare failures with the baseline: missing `three`, missing `react/jsx-dev-runtime`, and missing `paraglide-js` are pre-existing dependency-resolution failures unless changed by this work.
- [ ] Store the completed implementation and verification summary in ICM before reporting completion.
