# AI Analysis Chat Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated analysis deletion, collapsible analysis regions, and explicit chat clearing to the lap-analysis and compare AI panels.

**Architecture:** Keep analysis state independent from chat state. Add focused DELETE routes for stored analysis records, wire each card's bin to its own mutation, and add a shared collapsible analysis-region pattern in each panel. Chat clear calls the existing chat DELETE route only and remounts `ChatPanel`.

**Tech Stack:** React, TypeScript, Hono, Drizzle query helpers, TanStack Query, lucide-react, Bun tests, Tailwind utility classes.

## Global Constraints

- Analysis-card delete removes only the selected persisted analysis result.
- Chat clear removes only persisted chat messages/generations for that chat.
- Neither operation affects the other or sibling analyses.
- Collapse defaults expanded and leaves chat available at full remaining height when collapsed.
- Reuse existing `Trash2`, `RefreshCw`, button styles, and panel state patterns.
- Verify behavior in browser and run focused Bun tests; do not claim full build success if unrelated existing errors remain.

---

### Task 1: Add isolated analysis DELETE routes

**Files:**
- Modify: `server/routes/lap-routes.ts` near `/api/laps/:id/analyse`
- Modify: `server/db/queries.ts` only if the existing lap delete helper cannot cover the route
- Test: `test/ai-analysis-delete-routes.test.ts`

**Interfaces:**
- Consumes: existing `deleteAnalysisQuery(lapId)` helper and existing compare-inputs `deleteCompareAnalysis(id1, id2, "inputs")` route.
- Produces: `DELETE /api/laps/:id/analyse` deleting only that lap's persisted analysis. Compare lap cards reuse this endpoint with their individual lap IDs; inputs comparison keeps its existing DELETE endpoint.

- [ ] **Step 1: Inspect existing route ordering and parameter schema.** Confirm the lap analyse POST route's `IdParamSchema` and place the DELETE route beside the lap analyse routes.
- [ ] **Step 2: Add lap analysis DELETE route.** Validate `:id` with `IdParamSchema`, call `deleteAnalysisQuery(id)`, return `{ ok: true }`, and keep chat untouched.
- [ ] **Step 3: Add route-level regression coverage.** Exercise the lap DELETE path and existing inputs DELETE path against isolated records; assert sibling analyses and chat records remain.
- [ ] **Step 4: Run focused route tests.** Run `bun test test/ai-analysis-delete-routes.test.ts --timeout 30000` and expect PASS.
- [ ] **Step 5: Commit.** `git add server/routes/lap-routes.ts server/db/queries.ts test/ai-analysis-delete-routes.test.ts && git commit -m "feat: add isolated analysis delete route"`.

### Task 2: Add lap-analysis card controls and collapsible region

**Files:**
- Modify: `client/src/components/AiPanel.tsx`
- Modify: `client/src/components/ai/analysis-display.tsx` only if its existing regenerate/clear control needs a shared callback adjustment
- Test: `client/test/ai-analysis-chat-controls.test.tsx`

**Interfaces:**
- Consumes: `DELETE /api/laps/:id/analyse`, existing `fetchAnalysis`, `chatRemountKey`, and `ChatPanel` props.
- Produces: lap analysis bin that deletes only the result; analysis-region collapse state; labelled `Clear chat` control that calls `/api/laps/:id/chat` only.

- [ ] **Step 1: Add lap panel UI state.** Track `analysisCollapsed` and a pending delete state. Default `analysisCollapsed` to `false`.
- [ ] **Step 2: Add isolated analysis deletion callback.** Call `DELETE /api/laps/${lapId}/analyse`; on success clear `analysis`, `usage`, `error`, highlights, and modal state without changing chat remount state; on failure surface the existing panel error path.
- [ ] **Step 3: Add bin beside the lap analysis refresh/regenerate affordance.** Use `Trash2`, accessible label/title, disabled while loading or deleting, and ensure it only invokes the analysis DELETE callback.
- [ ] **Step 4: Wrap analysis result content in a collapsible region.** Add an expanded/collapsed toggle with an accessible label and chevron; collapsed state preserves the chat area and removes analysis content from layout so chat can expand.
- [ ] **Step 5: Add `Clear chat` to the lap chat header.** Call the existing lap chat DELETE route only and increment `chatRemountKey` after completion; preserve analysis state.
- [ ] **Step 6: Verify client state transitions with focused tests.** Assert analysis delete does not call chat DELETE, chat clear does not call analysis DELETE, and collapsed state is represented by the expected control/state contract.
- [ ] **Step 7: Run focused client tests.** Run `bun test client/test/ai-analysis-chat-controls.test.tsx --timeout 30000` and expect PASS.
- [ ] **Step 8: Commit.** `git add client/src/components/AiPanel.tsx client/src/components/ai/analysis-display.tsx client/test/ai-analysis-chat-controls.test.tsx && git commit -m "feat: add lap analysis chat controls"`.

### Task 3: Add compare-card deletion, collapse, and chat clear

**Files:**
- Modify: `client/src/components/comparison/CompareAiPanel.tsx`
- Test: `client/test/ai-analysis-chat-controls.test.tsx`

**Interfaces:**
- Consumes: lap-analysis DELETE route for both compare lap cards, existing inputs-analysis DELETE endpoint, `clearChat`, `chatRemountKey`, and per-card `run` callbacks.
- [ ] **Step 1: Extend analysis hooks with delete callbacks.** Add `remove` to `useLapAnalysis` and `useInputsAnalysis`; each calls its matching DELETE endpoint, clears only its hook state, and reports errors without touching other hooks.
- [ ] **Step 2: Render bin controls beside each refresh icon.** Pass each hook's remove callback into `LapSection`/`InputsSection`; disable both controls while that card is loading or deleting; preserve existing regenerate behavior.
- [ ] **Step 3: Add compare analysis-region collapse state.** Keep all three cards and readiness gate inside one collapsible region; when collapsed, leave compare chat mounted and allow it to consume available height.
- [ ] **Step 4: Add explicit compare `Clear chat` label/button.** Keep it in the chat header area, call existing compare chat DELETE only, and increment `chatRemountKey`; do not alter `hasA`, `hasB`, or `hasInputs`.
- [ ] **Step 5: Handle deletion during viewing.** If the deleted card is open in a modal, close the modal; deleting one card must not close or reset sibling card modals/results.
- [ ] **Step 6: Add focused tests.** Assert each analysis delete endpoint is independent, compare chat clear uses only the chat endpoint, and collapse changes layout without unmounting chat state.
- [ ] **Step 7: Run focused client tests.** Run `bun test client/test/ai-analysis-chat-controls.test.tsx --timeout 30000` and expect PASS.
- [ ] **Step 8: Commit.** `git add client/src/components/comparison/CompareAiPanel.tsx client/test/ai-analysis-chat-controls.test.tsx && git commit -m "feat: add compare analysis chat controls"`.

### Task 4: Browser verification and final cleanup

**Files:**
- Modify: only files required by verification findings; no unrelated refactors.
- Test: existing focused tests plus browser session.

**Interfaces:**
- Consumes: completed lap and compare controls/routes.
- Produces: verified end-to-end behavior for both AI surfaces.

- [ ] **Step 1: Start the existing development app using repository commands.** Use the project’s normal dev startup and wait for the client/server readiness signal.
- [ ] **Step 2: Verify lap analysis page.** Load an analysis, delete it, confirm only that result disappears; reload/regenerate; clear chat and confirm analysis remains; collapse/expand analysis and confirm chat gains/releases space.
- [ ] **Step 3: Verify compare chat panel.** Load Lap A, Lap B, and Inputs analyses; delete each independently; confirm sibling cards and chat remain; clear chat; collapse/expand all cards and confirm chat layout changes.
- [ ] **Step 4: Verify accessibility and pending states.** Confirm bin, collapse, expand, and clear-chat controls have accessible names and cannot trigger duplicate requests while pending.
- [ ] **Step 5: Run focused tests and type diagnostics.** Run `bun test` for touched focused tests and the available client diagnostics/build command; report unrelated pre-existing failures separately.
- [ ] **Step 6: Commit any verification-only fixes.** Use a focused conventional commit if changes were required.
