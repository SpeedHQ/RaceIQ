# Setup Version Branching + Commit-Graph UI — Design

**Date:** 2026-07-16
**Feature area:** Setup IQ / Setup Engineer (ACC + AC-EVO tuning sessions)
**Status:** Approved design, pre-plan

## Problem

The Setup Engineer keeps a linear version history per tuning session (`v1 → v2 → v3`).
Every `apply_changes` forks off the newest test and the number is `max(version) + 1`.
"Active" is hard-coded to `tests[tests.length - 1]` (the tip). There is no way to go
back to an earlier version and try a different direction without overwriting the
mainline — the exact failure captured in `tune-session-61`, where the user asked to
"branch from v1 … do not replace v2" and the agent could only offer to *revert* to v1.

We want real branching: fork from any version, keep a tree, and render it as a
git-style commit graph the user can navigate.

## Goals

- Fork a new version from **any** node, not just the tip.
- A persisted "current head" per session **and** an in-chat `branch-from-version` tool.
- Branch-relative dotted labels: mainline stays flat (`v1 → v2 → v3`), forks nest
  (`v1 → v1.1 → v1.2`).
- Replace the flat "Tune tests" table with a commit graph; click a node to check it out.
- Correct lap→version attribution by stamping the head test id onto each lap.
- Checkout is written into the chat thread (deterministic canned ack) so the agent
  keeps correct context.

## Non-goals

- Merging branches (git-merge semantics). Tree only, no merge nodes.
- Renaming/deleting arbitrary nodes, rebase, cherry-pick.
- Multi-user concurrency on a session.
- Changing the older non-session autotune pipeline (`POST /api/tunes/auto`).

## Current-state facts (verified)

- `tuning_tests` (schema.ts:241–261) already has: `version` (int), `label` (text),
  `setupPath`, **`parentTestId` (int, no hard FK, migration v24)**, `appliedChanges`
  (JSON), `engine`, `status`, `createdAt`. The lineage column already exists.
- `createTuningTest` already accepts `label` and `parentTestId`
  (`server/db/tuning-test-queries.ts:5–33`). No label migration needed.
- `listTuningTests` orders `version ASC, id ASC` (tuning-test-queries.ts:37–44).
- `loadActiveTuningContext` sets `activeTest = tests[tests.length - 1]`
  (`server/ai/setup-engineer-context.ts:160`). Single source of truth for "active".
- `apply-changes` (`mastra/tools/setup-engineer.ts:189–265`): `nextVer = max(version)+1`,
  `parentTestId = active.id`, writes `<stem>-vN.json` via `writeSetupFile`, posts a
  markdown summary through `saveAssistantChatMessage`.
- `saveAssistantChatMessage(threadId, markdown)` (`server/ai/chat-agent.ts:101–129`)
  appends an assistant message into the Mastra thread `tune-session-<id>`. Reusable.
- Client: `TuningSessionWorkspace.tsx` renders the flat table (rows 225–270) and groups
  laps to versions by **createdAt time window** (97–118). `TuningTest` type in
  `client/src/hooks/queries.ts:686–699` has `version`, `parentTestId`, `appliedChanges`.

## Design

### A. Data model (schema + migrations)

Reuse `tuning_tests.parentTestId` as the graph edge. Keep integer `version` as the
**stable identity / monotonic tiebreak** (never reused), and use `label` for the dotted
display string. Two new columns:

1. `tuning_sessions.headTestId INTEGER` (nullable) — the persisted checked-out node.
   `null` = fall back to mainline tip (back-compat for existing sessions).
2. `laps.tuningTestId INTEGER` (nullable) — stamped at save (§F). Mirrors the existing
   `laps.tuningSessionId` stamp.

Migrations (hand-rolled, per repo convention — edit `schema.ts` for Drizzle types, then
append SQL to `server/db/migrations.ts`):
- **v27** — `ALTER TABLE tuning_sessions ADD COLUMN head_test_id INTEGER`
- **v28** — `ALTER TABLE laps ADD COLUMN tuning_test_id INTEGER`

(No column for `label` — it already exists.)

### B. Numbering algorithm

Pure function `computeChildLabel(parentLabel: string, parentChildCount: number): string`
where `parentChildCount` = number of children the parent **already** has (0 for the first).

- **First child** (`parentChildCount === 0`) → increment the parent label's last numeric
  segment: `v1→v2`, `v2→v3`, `v1.1→v1.2`. (Mainline / a branch's own line stays flat.)
- **Fork** (`parentChildCount >= 1`) → append `.k`: `v1→v1.1`, then `v1.2`, …
  where `k = parentChildCount` counted over append-style children.

Root test label = `v1` (or seeded `base` keeps its label; its first child computes off
`v1`).

Label is **display sugar**; identity is row `id` + integer `version`. In pathological
multi-fork trees a computed label may collide with an existing one — resolve by bumping
to the next free label (`while (labelExists) increment`). Correctness never depends on
the label being unique; it depends on `id`.

Unit-tested with a table of cases: linear mainline, single fork, fork-then-continue,
multi-fork sibling, deep nesting, collision bump.

### C. Server routes (`server/routes/tune-routes.ts`)

- **`POST /api/tuning-sessions/:id/head`** `{ testId }` — set `headTestId`. Validates the
  test exists and belongs to the session (else 400/404). On success also writes the
  checkout note to the chat thread (§H). Returns the updated head.
- **`GET /api/tuning-sessions/:id/tests`** — extend the response: each test gains its
  dotted `label`, `parentTestId`, and a `lapCount` / `bestLapMs` derived from
  `laps.tuningTestId`. Client builds the tree from `parentTestId` edges — no separate
  graph endpoint.
- **`POST /api/tuning-sessions/:id/tests`** (manual record) — parent = current head
  (not forced tip); compute `label` via §B.

New query helpers in `tuning-session-queries.ts` (`updateSessionHead`) and
`tuning-test-queries.ts` (`countChildren(parentId)`, `labelExists(sessionId, label)`,
lap-count aggregation).

### D. AI tools (`mastra/tools/setup-engineer.ts` + `setup-engineer-context.ts`)

- `loadActiveTuningContext`: "active" resolves to the session's `headTestId` when set,
  else the current mainline tip (`tests[last]`) for back-compat. All reads
  (`get-setup`, `preview-change`, `apply-changes`) resolve off head.
- `apply-changes`:
  - parent = head test (`ctx.activeTest`, now head-resolved).
  - `version = nextVersion(sessionId)` (monotonic, unchanged).
  - `label = computeChildLabel(parentLabel, countChildren(parent))` (§B).
  - Save file `<stem>-<label>.json` (label replaces the old `-vN` suffix; keep
    collision auto-increment in `writeSetupFile`).
  - On success **advance `headTestId` to the new node** so the branch grows and head
    follows the work.
- **New tool `branch-from-version`** `{ target: string }` — resolves `target` against a
  test's `label` or integer `version`, sets `headTestId` to that node, returns a short
  confirmation. The next `apply-changes` then forks there. Directly answers
  "branch from v1, don't replace v2".
- `get-version-history` — include `label` + `parentTestId` so the agent can describe
  lineage in prose.

### E. Client graph UI (`client/src/components/tunes/TuningSessionWorkspace.tsx`)

Replace the flat "Tune tests (setup versions)" table with a vertical commit graph:

- Nodes ordered by `version` (creation order); lineage rails drawn from `parentTestId`
  using SVG/CSS (a left gutter with dots + connectors). No new heavy dependency.
- Each node row: dotted `label`, applied-changes summary (reuse `AppliedChangesList`),
  lap count + best lap, engine badge (`rules`/`llm`), `base` marker on the root.
- **Laps are listed under their setup node** — each node shows the laps driven on that
  version (grouped by `laps.tuningTestId`, §F): lap time, valid/invalid, delta to the
  node's best. This is the existing per-lap breakdown, now attached to the exact node the
  laps belong to instead of a chronological guess. A node with no laps shows "no laps yet".
- The current head node is highlighted. **Click a node → `useSetHead` mutation → `POST
  /head`**, then invalidate the tests query, the chat query, and re-render. Expanding a
  node reveals its full lap list + applied-changes detail; the lap count stays visible
  collapsed.
- `TuningTest` type gains `label`, `lapCount`, `bestLapMs`. New `useSetHead` hook.

### F. Lap attribution (`server/pipeline.ts` + active-session plumbing)

- On lap save, stamp `laps.tuningTestId` = the active session's current `headTestId`
  (mirrors the existing `tuningSessionId` stamp; resolved via `server/tuning-active.ts`).
  Fix at source (parser/pipeline), not the UI.
- Graph groups laps by `tuningTestId`. Rows/laps with `null` (pre-migration) fall back to
  the createdAt time-window heuristic once, so existing sessions still render.

### G. Checkout → chat thread (deterministic canned ack)

- `POST /:id/head` calls `saveAssistantChatMessage(tuneSessionThreadId(id), markdown)`
  with a **deterministic** message, e.g.
  `"Switched to **v1.1** as the current setup — I'll work from here."`
- No LLM call: instant, free, cannot hallucinate. The message persists in thread memory,
  so the next real chat turn sees the head change as context (the fix for the
  `tune-session-61` confusion).
- The client invalidates the chat query after checkout so the message appears inline.
- `saveAssistantChatMessage` is reused as-is (assistant-role message with no preceding
  user turn — same shape `apply_changes` already produces).

### H. Testing

- **Unit** — `computeChildLabel` case table (mainline, fork, fork-continue, multi-fork,
  deep, collision bump).
- **Route** — `POST /head` sets head + writes the chat note; `apply-changes` forks off
  head, not tip; `branch-from-version` resolves by label and by integer.
- **Pipeline** — lap save stamps `tuningTestId` = session head (Capturing adapters).
- **Back-compat** — a session with `headTestId = null` still resolves to the tip; laps
  with `tuningTestId = null` still group via the time-window fallback.

## Risks / open items

- **Label collisions** in exotic multi-fork trees — mitigated by the uniqueness bump;
  integer `version` + row `id` remain the real key, so this is cosmetic only.
- **Graph rendering complexity** — kept to a vertical single-column tree with rails; not
  a full DAG layout engine. Wide fan-out renders as nested indentation.
- **Migration ordering** — v27/v28 must be appended after the current highest version in
  `migrations.ts`; verify the next free number at implementation time.
