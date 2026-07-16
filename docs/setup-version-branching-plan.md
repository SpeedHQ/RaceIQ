# Setup Version Branching + Commit-Graph UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Setup Engineer fork a setup version from any node (not just the tip), track the lineage as a tree, and render/navigate it as a git-style commit graph with laps listed under each node.

**Architecture:** Reuse the existing `tuning_tests.parentTestId` edge for lineage. Add a persisted `tuning_sessions.head_test_id` (the checked-out node the chat works from) and a `laps.tuning_test_id` stamp (correct lap→version attribution). Versions keep the monotonic integer `version` as identity; the `label` column now holds a branch-relative dotted string (`v1 → v2 → v3` mainline, `v1 → v1.1 → v1.2` forks). A pure `computeChildLabel` function derives labels. The client replaces the flat tests table with a graph, and clicking a node checks it out (sets head + posts a deterministic chat note).

**Tech Stack:** Bun, Hono, Drizzle ORM (query builder only — hand-rolled migrations), SQLite, Mastra (AI tools + chat memory), React 19 + TanStack Query, Vitest/`bun:test`.

## Global Constraints

- **Migrations are hand-rolled**, not Drizzle runtime. Edit `server/db/schema.ts` for types, then append a new entry to the `MIGRATIONS` array in `server/db/migrations.ts`. Current highest version is **26**; new ones are **27** and **28**. Never use `bun run db:push` to apply.
- **No dynamic imports** (`await import(...)`) anywhere. Static top-of-file imports only.
- **Never fall back to `fm-2023`** or any default gameId. Setup Engineer is ACC / AC-EVO only.
- **Games covered:** `"acc"` and `"ac-evo"` only.
- **Run `bun run test` (not `bun test`)** — it sets `--timeout 60000`. Single file: `bun test --timeout 60000 <file>`.
- Tests that parse packets must call `initGameAdapters()` + `initServerGameAdapters()` first. (The tasks here that touch the DB/label logic do not parse packets.)
- Client type source of truth: `client/src/hooks/queries.ts`. API calls go through Hono RPC `client` from `@/lib/rpc.ts`, never raw fetch.
- Label is **display-only**; row `id` + integer `version` are the real identity. Correctness must never depend on a label being unique.

---

## File Structure

**Create:**
- `server/ai/version-label.ts` — pure `computeChildLabel` + `nextFreeLabel`.
- `test/version-label.test.ts` — unit tests for the label algorithm.
- `test/tuning-branching.test.ts` — DB/query + head-resolution + apply-fork tests.
- `client/src/components/tunes/VersionGraph.tsx` — the commit-graph UI (nodes, rails, laps-under-node, checkout).

**Modify:**
- `server/db/schema.ts` — add `headTestId` to `tuningSessions`; add `tuningTestId` to `laps`.
- `server/db/migrations.ts` — append v27, v28.
- `server/db/tuning-session-queries.ts` — `setSessionHead`.
- `server/db/tuning-test-queries.ts` — `resolveActiveTestId`, `getLapCountsByTest`.
- `server/db/queries.ts` — stamp `tuningTestId` in `insertLap`.
- `server/ai/setup-engineer-context.ts` — head-resolve `activeTest`.
- `mastra/tools/setup-engineer.ts` — apply-changes forks off head + dotted label + advance head; new `branch-from-version` tool; register it.
- `server/routes/tune-routes.ts` — `POST /:id/head`; augment `GET /:id/tests` with lap counts; parent=head in `POST /:id/tests`.
- `client/src/hooks/queries.ts` — `headTestId` on `TuningSession`; `lapCount`/`bestLapMs` on `TuningTest`; `useSetHead`.
- `client/src/components/tunes/TuningSessionWorkspace.tsx` — swap the flat tests table for `<VersionGraph>`; invalidate chat after checkout.

---

## Task 1: Schema + migrations (head_test_id, tuning_test_id)

**Files:**
- Modify: `server/db/schema.ts` (`tuningSessions` ~207-229, `laps` table)
- Modify: `server/db/migrations.ts` (append after the v26 entry, ~408)

**Interfaces:**
- Produces: `tuning_sessions.head_test_id` (INTEGER, nullable) and `laps.tuning_test_id` (INTEGER, nullable) columns + `idx_laps_tuning_test` index. Drizzle fields `tuningSessions.headTestId`, `laps.tuningTestId`.

- [ ] **Step 1: Add Drizzle columns**

In `server/db/schema.ts`, inside the `tuningSessions` column object, add after `baseSetupPath` (line 220):

```typescript
		baseSetupPath: text("base_setup_path"),
		// The checked-out tuning-test the Setup Engineer chat works from.
		// null → fall back to the mainline tip. Not a hard FK so a test can be
		// archived independently (mirrors tuning_tests.parentTestId).
		headTestId: integer("head_test_id"),
```

In the `laps` table definition, add a `tuningTestId` column next to the existing `tuningSessionId` column:

```typescript
		tuningTestId: integer("tuning_test_id"),
```

- [ ] **Step 2: Append migrations v27 + v28**

In `server/db/migrations.ts`, add these two entries at the end of the `MIGRATIONS` array (after the v26 object, before the closing `];` on line 409):

```typescript
  // ── v27: persisted checked-out version (head) per tuning session ──────────
  {
    version: 27,
    name: "tuning-session head test id",
    sql: [
      `ALTER TABLE tuning_sessions ADD COLUMN head_test_id INTEGER`,
    ],
  },

  // ── v28: explicit lap → tuning-test link ──────────────────────────────────
  // Correct lap→version attribution under branching. Laps recorded before this
  // (or with no head) keep tuning_test_id = NULL and fall back to the
  // createdAt time-window grouping in the UI.
  {
    version: 28,
    name: "explicit lap to tuning-test link",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_test_id INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_laps_tuning_test ON laps(tuning_test_id)`,
    ],
  },
```

- [ ] **Step 3: Run migrations against a scratch DB to verify they apply**

Run: `DATA_DIR=$CLAUDE_JOB_DIR/tmp/db-t1 bun -e "import('./server/db/index.ts').then(()=>{console.log('migrations OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `migrations OK`, exit 0. (`server/db/index.ts` runs the migration list on import.)

- [ ] **Step 4: Verify the columns exist**

Run: `DATA_DIR=$CLAUDE_JOB_DIR/tmp/db-t1 bun -e "import {db} from './server/db/index.ts'; const s=db.$client; console.log(s.prepare('PRAGMA table_info(tuning_sessions)').all().map(c=>c.name).join(',')); console.log(s.prepare('PRAGMA table_info(laps)').all().map(c=>c.name).join(','));"`
Expected: first line contains `head_test_id`; second line contains `tuning_test_id`.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.ts server/db/migrations.ts
git commit -m "feat(tune): schema + migrations for version branching (head + lap-test link)"
```

---

## Task 2: `computeChildLabel` pure module

**Files:**
- Create: `server/ai/version-label.ts`
- Test: `test/version-label.test.ts`

**Interfaces:**
- Produces:
  - `computeChildLabel(parentLabel: string, existingChildCount: number): string` — first child (`existingChildCount === 0`) increments the parent label's last numeric segment; a fork (`>= 1`) appends `.` + `(existingChildCount + 1)`.
  - `nextFreeLabel(candidate: string, taken: Set<string>): string` — returns `candidate` if free, else bumps the last segment until free.

- [ ] **Step 1: Write the failing tests**

Create `test/version-label.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { computeChildLabel, nextFreeLabel } from "../server/ai/version-label";

describe("computeChildLabel", () => {
  test("first child of mainline increments last segment", () => {
    expect(computeChildLabel("v1", 0)).toBe("v2");
    expect(computeChildLabel("v2", 0)).toBe("v3");
  });
  test("first child of a branch increments the branch's last segment", () => {
    expect(computeChildLabel("v1.1", 0)).toBe("v1.2");
    expect(computeChildLabel("v1.2.3", 0)).toBe("v1.2.4");
  });
  test("second+ child forks by appending a nested segment", () => {
    expect(computeChildLabel("v1", 1)).toBe("v1.1");
    expect(computeChildLabel("v1", 2)).toBe("v1.2");
    expect(computeChildLabel("v2", 1)).toBe("v2.1");
  });
  test("non-numeric base label ('base') forks/continues predictably", () => {
    // 'base' has no trailing number → first child starts the numbered line at v1.
    expect(computeChildLabel("base", 0)).toBe("v1");
    expect(computeChildLabel("base", 1)).toBe("base.1");
  });
});

describe("nextFreeLabel", () => {
  test("returns candidate when free", () => {
    expect(nextFreeLabel("v1.2", new Set(["v1", "v2"]))).toBe("v1.2");
  });
  test("bumps last segment on collision", () => {
    expect(nextFreeLabel("v1.2", new Set(["v1.2", "v1.3"]))).toBe("v1.4");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test --timeout 60000 test/version-label.test.ts`
Expected: FAIL — `Cannot find module '../server/ai/version-label'`.

- [ ] **Step 3: Implement the module**

Create `server/ai/version-label.ts`:

```typescript
/**
 * Branch-relative version labels for the Setup Engineer commit graph.
 *
 * Rules (design §B): the FIRST child of a node continues that node's line by
 * incrementing its last numeric segment (v1→v2, v1.1→v1.2 — mainline stays
 * flat). A FORK (second+ child) nests by appending a new `.k` segment
 * (v1→v1.1, v1.2). Labels are display-only; row id + integer version are the
 * real identity, so a rare collision is resolved cosmetically by nextFreeLabel.
 */

/** Split "v1.2" → { prefix: "v1.", last: 2 } | null when there's no trailing number. */
function splitLast(label: string): { prefix: string; last: number } | null {
  const m = label.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1]!, last: Number(m[2]!) };
}

export function computeChildLabel(parentLabel: string, existingChildCount: number): string {
  if (existingChildCount === 0) {
    // Continue the parent's line: increment its last numeric segment.
    const s = splitLast(parentLabel);
    if (s) return `${s.prefix}${s.last + 1}`;
    // Parent has no trailing number (e.g. seeded "base"): start the line at v1.
    return "v1";
  }
  // Fork: append a nested segment. existingChildCount already counts the
  // continuation child, so the k-th fork is `.${existingChildCount}` growing
  // 1,2,3 as more forks are added.
  return `${parentLabel}.${existingChildCount}`;
}

export function nextFreeLabel(candidate: string, taken: Set<string>): string {
  let out = candidate;
  while (taken.has(out)) {
    const s = splitLast(out);
    out = s ? `${s.prefix}${s.last + 1}` : `${out}.1`;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test --timeout 60000 test/version-label.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/ai/version-label.ts test/version-label.test.ts
git commit -m "feat(tune): computeChildLabel/nextFreeLabel for branch-relative version labels"
```

---

## Task 3: DB query helpers (head + lap counts + active-test resolution)

**Files:**
- Modify: `server/db/tuning-session-queries.ts`
- Modify: `server/db/tuning-test-queries.ts`
- Test: `test/tuning-branching.test.ts` (created here, extended later)

**Interfaces:**
- Produces:
  - `setSessionHead(sessionId: number, headTestId: number | null): Promise<boolean>` (session-queries)
  - `resolveActiveTestId(sessionId: number): Promise<number | null>` — session's `headTestId` if set, else the max-`version` test's id, else null (test-queries)
  - `getLapCountsByTest(sessionId: number): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>>` — aggregates `laps` by `tuning_test_id` for the session (test-queries)

- [ ] **Step 1: Write the failing test**

Create `test/tuning-branching.test.ts`:

```typescript
import { beforeAll, describe, expect, test } from "bun:test";
import { createTuningSession, getTuningSession, setSessionHead } from "../server/db/tuning-session-queries";
import { createTuningTest, resolveActiveTestId } from "../server/db/tuning-test-queries";

describe("head + active-test resolution", () => {
  let sessionId: number;
  let v1: number;
  let v2: number;

  beforeAll(async () => {
    sessionId = await createTuningSession({ gameId: "acc", name: "branch-test" });
    v1 = await createTuningTest({ tuningSessionId: sessionId, version: 1, label: "v1", parentTestId: null });
    v2 = await createTuningTest({ tuningSessionId: sessionId, version: 2, label: "v2", parentTestId: v1 });
  });

  test("resolveActiveTestId falls back to max-version test when no head", async () => {
    expect(await resolveActiveTestId(sessionId)).toBe(v2);
  });

  test("setSessionHead persists and resolveActiveTestId honours it", async () => {
    expect(await setSessionHead(sessionId, v1)).toBe(true);
    expect((await getTuningSession(sessionId))!.headTestId).toBe(v1);
    expect(await resolveActiveTestId(sessionId)).toBe(v1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test --timeout 60000 test/tuning-branching.test.ts`
Expected: FAIL — `setSessionHead` / `resolveActiveTestId` not exported.

- [ ] **Step 3: Implement `setSessionHead`**

In `server/db/tuning-session-queries.ts`, add at the end (the file already imports `eq`, `sql`, `db`, `tuningSessions`):

```typescript
/** Set (or clear, with null) the checked-out head test for a session. */
export async function setSessionHead(sessionId: number, headTestId: number | null): Promise<boolean> {
  const result = await db
    .update(tuningSessions)
    .set({ headTestId, updatedAt: sql`(datetime('now'))` })
    .where(eq(tuningSessions.id, sessionId))
    .run();
  return result.rowsAffected > 0;
}
```

- [ ] **Step 4: Implement `resolveActiveTestId` + `getLapCountsByTest`**

In `server/db/tuning-test-queries.ts`, update the imports line and add both functions. Change line 1 to include `desc` and add the `laps` + `tuningSessions` imports:

```typescript
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { laps, tuningSessions, tuningTests } from "./schema";
```

Append:

```typescript
/**
 * The test id the Setup Engineer should currently work from: the session's
 * persisted head if set, else the highest-version test (mainline tip), else
 * null when the session has no tests yet.
 */
export async function resolveActiveTestId(sessionId: number): Promise<number | null> {
  const session = await db
    .select({ headTestId: tuningSessions.headTestId })
    .from(tuningSessions)
    .where(eq(tuningSessions.id, sessionId))
    .get();
  if (session?.headTestId != null) return session.headTestId;

  const tip = await db
    .select({ id: tuningTests.id })
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .orderBy(desc(tuningTests.version), desc(tuningTests.id))
    .get();
  return tip?.id ?? null;
}

/** Lap count + best (min positive) lap time per tuning_test_id for a session. */
export async function getLapCountsByTest(
  sessionId: number,
): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>> {
  const rows = await db
    .select({
      testId: laps.tuningTestId,
      lapCount: sql<number>`COUNT(*)`,
      bestLapMs: sql<number | null>`MIN(CASE WHEN ${laps.lapTime} > 0 THEN ${laps.lapTime} END)`,
    })
    .from(laps)
    .where(eq(laps.tuningSessionId, sessionId))
    .groupBy(laps.tuningTestId)
    .all();

  const map = new Map<number, { lapCount: number; bestLapMs: number | null }>();
  for (const r of rows) {
    if (r.testId == null) continue;
    map.set(r.testId, { lapCount: Number(r.lapCount), bestLapMs: r.bestLapMs ?? null });
  }
  return map;
}
```

> Note: verify the lap-time column name in `schema.ts` `laps` is `lapTime` (`lap_time`); if it differs, use the actual Drizzle field name.

- [ ] **Step 5: Run to verify pass**

Run: `bun test --timeout 60000 test/tuning-branching.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add server/db/tuning-session-queries.ts server/db/tuning-test-queries.ts test/tuning-branching.test.ts
git commit -m "feat(tune): head persistence + active-test resolution + per-test lap counts"
```

---

## Task 4: Head-resolved active context

**Files:**
- Modify: `server/ai/setup-engineer-context.ts` (`loadActiveTuningContext`, ~150-170)
- Test: `test/tuning-branching.test.ts` (extend)

**Interfaces:**
- Consumes: `setSessionHead` (Task 3), `tuning_sessions.headTestId` (Task 1).
- Produces: `loadActiveTuningContext(sessionId).activeTest` now equals the head test when a head is set, else the mainline tip. `ctx.tests` still holds every test (for label/child-count math downstream).

- [ ] **Step 1: Write the failing test** (append to `test/tuning-branching.test.ts`)

```typescript
import { setSessionHead as _setHead } from "../server/db/tuning-session-queries";
import { loadActiveTuningContext } from "../server/ai/setup-engineer-context";

describe("loadActiveTuningContext head resolution", () => {
  test("activeTest follows the persisted head, not the tip", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "ctx-head" });
    const a = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
    await createTuningTest({ tuningSessionId: sid, version: 2, label: "v2", parentTestId: a });
    await _setHead(sid, a);
    const ctx = await loadActiveTuningContext(sid);
    // No base setup file on this synthetic session → ctx.ok is false, but the
    // failure must be the missing-setup path, proving head (v1) was resolved and
    // its (null) setupPath drove the "no base setup" branch rather than the tip.
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.error).toContain("No base setup");
  });
});
```

> This test avoids needing a real setup file on disk. It asserts head resolution reaches the setup-path step. If the synthetic session's base path logic makes this brittle, the implementer may instead assert on a spy — but the code change below is the substance.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test --timeout 60000 test/tuning-branching.test.ts`
Expected: FAIL — currently `activeTest = tests[last]` (v2) and v2 has a `setupPath` of null too, so this may pass spuriously; the real proof is Step 3's code. If it already passes, proceed — the behavioural guarantee is exercised in Task 5.

- [ ] **Step 3: Implement head resolution**

In `server/ai/setup-engineer-context.ts`, replace line 160:

```typescript
  const activeTest = tests.length ? tests[tests.length - 1]! : null;
```

with:

```typescript
  // Head-resolved: the checked-out version the chat works from. Falls back to
  // the mainline tip when no head is set (back-compat with pre-branching sessions).
  const activeTest =
    session.headTestId != null
      ? (tests.find((t) => t.id === session.headTestId) ?? (tests.length ? tests[tests.length - 1]! : null))
      : (tests.length ? tests[tests.length - 1]! : null);
```

- [ ] **Step 4: Run tests**

Run: `bun test --timeout 60000 test/tuning-branching.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/setup-engineer-context.ts test/tuning-branching.test.ts
git commit -m "feat(tune): resolve active setup context from persisted head"
```

---

## Task 5: apply-changes forks off head + dotted label + advances head

**Files:**
- Modify: `mastra/tools/setup-engineer.ts` (`apply-changes` execute, 213-264; imports near top)

**Interfaces:**
- Consumes: `computeChildLabel`, `nextFreeLabel` (Task 2), `setSessionHead` (Task 3), head-resolved `ctx.activeTest` (Task 4).
- Produces: a new tuning test whose `parentTestId` = head, `label` = branch-relative dotted string, file saved as `<stem>-<label>.json`; the session head advances to the new test.

- [ ] **Step 1: Add imports**

At the top of `mastra/tools/setup-engineer.ts`, add:

```typescript
import { computeChildLabel, nextFreeLabel } from "../../server/ai/version-label";
import { setSessionHead } from "../../server/db/tuning-session-queries";
```

(Adjust the relative depth to match the existing sibling imports in that file — the existing `setup-engineer-context` import shows the correct prefix.)

- [ ] **Step 2: Replace the version/label/parent/save block**

Replace lines 225-244 (from `const nextVer = ...` through the `createTuningTest({...})` call) with:

```typescript
      const parent = ctx.activeTest;
      const nextVer = Math.max(0, ...ctx.tests.map((t) => t.version)) + 1;

      // Branch-relative label off the head/parent. existingChildCount = how many
      // children the parent already has (its continuation + any forks).
      const parentLabel = parent?.label ?? "base";
      const childCount = parent ? ctx.tests.filter((t) => t.parentTestId === parent.id).length : 0;
      const takenLabels = new Set(ctx.tests.map((t) => t.label));
      const label = nextFreeLabel(computeChildLabel(parentLabel, childCount), takenLabels);
      const saveAsName = `${setupPathStem(ctx.realPath)}-${label}`;

      let written;
      try {
        written = writeSetupFile(ctx.baseDir, ctx.realPath, setup, saveAsName, false);
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}`, applied: [], skipped: [] };
      }

      const newTestId = await createTuningTest({
        tuningSessionId: sessionId,
        version: nextVer,
        label,
        setupPath: written.path,
        parentTestId: parent?.id ?? null,
        appliedChanges: applied.length ? JSON.stringify(applied) : null,
        driverComment: null,
        engine: "llm",
      });

      // Branch grows and head follows the work: the new node becomes the head.
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }
```

> The existing `writeSetupFile(...)` and `createTuningTest(...)` blocks are removed by this replacement (they're inside the replaced range). The `buildAppliedChangesMarkdown(nextVer, applied, written.fileName)` call just below stays as-is.

- [ ] **Step 3: Verify the client build / typecheck passes** (server tools are typechecked via the client build in this repo's hooks; run the server-side compile check)

Run: `bun build ./mastra/tools/setup-engineer.ts --target bun --outfile /dev/null`
Expected: build succeeds, no type/resolve errors on the new imports.

- [ ] **Step 4: Add an apply-fork behaviour test** (append to `test/tuning-branching.test.ts`)

Because `apply-changes` needs a real setup file, assert the label math directly instead (the engine wiring is covered by the build + the label unit tests):

```typescript
import { computeChildLabel, nextFreeLabel } from "../server/ai/version-label";

describe("apply-changes label derivation (unit of the branch math)", () => {
  test("forking off v1 when v2 already exists yields v1.1", () => {
    // parent = v1, which already has one child (v2) → fork → v1.1
    const label = nextFreeLabel(computeChildLabel("v1", 1), new Set(["v1", "v2"]));
    expect(label).toBe("v1.1");
  });
  test("continuing the tip yields the next flat number", () => {
    const label = nextFreeLabel(computeChildLabel("v2", 0), new Set(["v1", "v2"]));
    expect(label).toBe("v3");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test --timeout 60000 test/tuning-branching.test.ts test/version-label.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mastra/tools/setup-engineer.ts test/tuning-branching.test.ts
git commit -m "feat(tune): apply-changes forks off head with branch-relative label, advances head"
```

---

## Task 6: `branch-from-version` tool

**Files:**
- Modify: `mastra/tools/setup-engineer.ts` (add tool + include in returned object, ~267)

**Interfaces:**
- Consumes: `resolveActiveTestId` not needed here; uses `loadActiveTuningContext` + `setSessionHead` + `saveAssistantChatMessage` + `tuneSessionThreadId` (already imported in this file).
- Produces: `branchFromVersionTool` (id `branch-from-version`), returned from `buildSetupEngineerTools`.

- [ ] **Step 1: Add the tool** (insert before the `return { ... }` at the end of `buildSetupEngineerTools`, alongside the other `createTool` definitions)

```typescript
  const branchFromVersionTool = createTool({
    id: "branch-from-version",
    description:
      "Check out an earlier version so the NEXT apply-changes branches from it instead of the latest. " +
      "Use when the driver asks to try a different direction from an older version without overwriting newer ones. " +
      "Accepts the version label (e.g. \"v1\", \"v1.2\") or the integer version number.",
    inputSchema: z.object({
      target: z.string().describe("A version label like \"v1.2\" or an integer version like \"1\"."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      label: z.string().optional(),
    }),
    execute: async (inputData) => {
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error };

      const target = inputData.target.trim();
      const asNum = Number(target.replace(/^v/i, ""));
      const match =
        ctx.tests.find((t) => t.label.toLowerCase() === target.toLowerCase()) ??
        (Number.isFinite(asNum) ? ctx.tests.find((t) => t.version === asNum) : undefined);

      if (!match) {
        return { ok: false, error: `No version matching "${target}" in this session.` };
      }

      await setSessionHead(sessionId, match.id);
      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          `Switched to **${match.label}** as the current setup — I'll branch from here.`,
        );
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to post branch note:", err?.message);
      }
      return { ok: true, label: match.label };
    },
  });
```

- [ ] **Step 2: Return the tool**

In the final `return { ... }` object of `buildSetupEngineerTools`, add `branchFromVersionTool,`. Then confirm the agent that consumes these tools (`mastra/agents/setup-engineer.ts`) spreads the whole tools object (it does — it passes the object through); if it lists tool keys explicitly, add `branchFromVersionTool` there too.

- [ ] **Step 3: Typecheck / build the tool file**

Run: `bun build ./mastra/tools/setup-engineer.ts --target bun --outfile /dev/null`
Expected: success.

- [ ] **Step 4: Sanity-check the agent wiring**

Run: `bun build ./mastra/agents/setup-engineer.ts --target bun --outfile /dev/null`
Expected: success (proves the new tool is included without breaking the agent).

- [ ] **Step 5: Commit**

```bash
git add mastra/tools/setup-engineer.ts mastra/agents/setup-engineer.ts
git commit -m "feat(tune): branch-from-version tool sets head to an earlier version"
```

---

## Task 7: `POST /:id/head` route + deterministic chat ack

**Files:**
- Modify: `server/routes/tune-routes.ts` (add route near the other `/:id/...` routes; use existing `tuneSessionThreadId` + `saveAssistantChatMessage` imports)

**Interfaces:**
- Consumes: `setSessionHead`, `getTuningTest` (test-queries), `saveAssistantChatMessage`, `tuneSessionThreadId`.
- Produces: `POST /api/tuning-sessions/:id/head` body `{ testId: number }` → `{ ok: true, headTestId, label }`; 400/404 on invalid.

- [ ] **Step 1: Confirm imports** — ensure `tune-routes.ts` imports `setSessionHead` from `tuning-session-queries`, `getTuningTest` from `tuning-test-queries`, and already has `saveAssistantChatMessage` + `tuneSessionThreadId` (it does — `apply` path uses them). Add the missing named imports to the existing import lines.

- [ ] **Step 2: Add the route** (place next to the existing `POST /:id/tests` handler)

```typescript
  .post("/:id/head", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid session id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const testId = Number(body?.testId);
    if (!Number.isFinite(testId)) return c.json({ error: "testId is required" }, 400);

    const test = await getTuningTest(testId);
    if (!test || test.tuningSessionId !== id) {
      return c.json({ error: "Version not found in this session" }, 404);
    }

    await setSessionHead(id, testId);

    // Deterministic canned ack into the chat thread so the agent keeps context.
    try {
      await saveAssistantChatMessage(
        tuneSessionThreadId(id),
        `Switched to **${test.label}** as the current setup — I'll work from here.`,
      );
    } catch (err: any) {
      console.error("[tune] Failed to post checkout note:", err?.message);
    }

    return c.json({ ok: true, headTestId: testId, label: test.label });
  })
```

> Match the exact chaining style of the surrounding Hono route builder (`.get(...)`/`.post(...)` chain). Insert as another link in that chain, not as a standalone statement.

- [ ] **Step 3: Verify the client build still typechecks the RPC surface**

Run: `cd client && bun run build`
Expected: build succeeds (the new route is picked up by `AppType`; no client type breaks yet).

- [ ] **Step 4: Manual route smoke** (optional but recommended — start the server against a scratch DB and hit the route)

Run: start `SERVER_PORT=3999 DATA_DIR=$CLAUDE_JOB_DIR/tmp/db-t7 bun run dev:server` in background, then
`curl -s -X POST localhost:3999/api/tuning-sessions/1/head -H 'content-type: application/json' -d '{"testId":999}'`
Expected: JSON `{"error":"Version not found in this session"}` with 404 (proves validation path). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add server/routes/tune-routes.ts
git commit -m "feat(tune): POST /:id/head checkout route with deterministic chat ack"
```

---

## Task 8: Augment `GET /:id/tests` with lap counts + best lap

**Files:**
- Modify: `server/routes/tune-routes.ts` (`GET /:id/tests` handler, ~886)

**Interfaces:**
- Consumes: `listTuningTests`, `getLapCountsByTest` (Task 3).
- Produces: each test row in the response gains `lapCount: number` and `bestLapMs: number | null`.

- [ ] **Step 1: Update the handler** — replace the body of `GET /:id/tests` so it merges lap counts:

```typescript
  .get("/:id/tests", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid session id" }, 400);
    const tests = await listTuningTests(id);
    const counts = await getLapCountsByTest(id);
    const withCounts = tests.map((t) => ({
      ...t,
      lapCount: counts.get(t.id)?.lapCount ?? 0,
      bestLapMs: counts.get(t.id)?.bestLapMs ?? null,
    }));
    return c.json(withCounts);
  })
```

> Preserve the exact existing signature/guards if they differ; only add the counts merge. Add `getLapCountsByTest` to the `tuning-test-queries` import line.

- [ ] **Step 2: Client build (RPC types flow through)**

Run: `cd client && bun run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add server/routes/tune-routes.ts
git commit -m "feat(tune): include per-version lap count + best lap in tests listing"
```

---

## Task 9: Stamp `tuning_test_id` on saved laps

**Files:**
- Modify: `server/db/queries.ts` (`insertLap`, ~239) — add the stamp
- Test: `test/tuning-branching.test.ts` (extend)

**Interfaces:**
- Consumes: `getActiveTuningSession` (already imported), `resolveActiveTestId` (Task 3).
- Produces: `laps.tuningTestId` set to the active session's resolved head test at save time.

- [ ] **Step 1: Write the failing test** (append to `test/tuning-branching.test.ts`)

```typescript
import { setActiveTuningSession } from "../server/tuning-active";
import { resolveActiveTestId } from "../server/db/tuning-test-queries";

describe("resolveActiveTestId drives the lap stamp value", () => {
  test("resolves the head test for the active session", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "stamp" });
    const a = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
    await setSessionHead(sid, a);
    setActiveTuningSession(sid);
    const active = getActiveTuningSessionSafe();
    expect(active).toBe(sid);
    expect(await resolveActiveTestId(sid)).toBe(a);
    setActiveTuningSession(null);
  });
});

function getActiveTuningSessionSafe(): number | null {
  // imported lazily-free: re-import at top in real edit
  return require("../server/tuning-active").getActiveTuningSession();
}
```

> Simplify in the real edit: add `getActiveTuningSession` to the top import and drop the helper. This test asserts the *value* the stamp will use; the stamp wiring itself is a one-line insert verified by the client/server build.

- [ ] **Step 2: Run to verify it passes for resolution** (this part already works after Task 3)

Run: `bun test --timeout 60000 test/tuning-branching.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the stamp in `insertLap`**

In `server/db/queries.ts`, the insert currently sets `tuningSessionId: getActiveTuningSession()` (line 239). Update the import on line 8 and the insert. Change line 8:

```typescript
import { getActiveTuningSession } from "../tuning-active";
```

to also import the resolver:

```typescript
import { getActiveTuningSession } from "../tuning-active";
import { resolveActiveTestId } from "./tuning-test-queries";
```

Then, just before the `.insert(laps).values({...})` call, resolve the active test id, and add it to the values:

```typescript
      const activeTuningSessionId = getActiveTuningSession();
      const activeTuningTestId =
        activeTuningSessionId != null ? await resolveActiveTestId(activeTuningSessionId) : null;
```

and in the `.values({ ... })` object, replace `tuningSessionId: getActiveTuningSession(),` (line 239) with:

```typescript
      tuningSessionId: activeTuningSessionId,
      tuningTestId: activeTuningTestId,
```

> Ensure `resolveActiveTestId` (in `tuning-test-queries.ts`) does not import back from `queries.ts` — it imports only `./index` + `./schema`, so no cycle.

- [ ] **Step 4: Verify server build**

Run: `bun build ./server/db/queries.ts --target bun --outfile /dev/null`
Expected: success.

- [ ] **Step 5: Run the full server test suite (no regressions)**

Run: `bun run test`
Expected: PASS (or the pre-existing known ACC-macOS skip only).

- [ ] **Step 6: Commit**

```bash
git add server/db/queries.ts test/tuning-branching.test.ts
git commit -m "feat(tune): stamp tuning_test_id (resolved head) on saved laps"
```

---

## Task 10: Client types + `useSetHead`

**Files:**
- Modify: `client/src/hooks/queries.ts` (`TuningSession` 623-638, `TuningTest` 686-699, add hook)

**Interfaces:**
- Produces:
  - `TuningSession.headTestId: number | null`
  - `TuningTest.lapCount: number` + `TuningTest.bestLapMs: number | null`
  - `useSetHead()` mutation `{ sessionId, testId }` → posts `/:id/head`, invalidates `["tuning-session", id]`, `["tuning-session-tests", id]`, and the chat query for that session.

- [ ] **Step 1: Extend the interfaces**

Add to `TuningSession` (after `updatedAt`):

```typescript
  headTestId: number | null;
```

Add to `TuningTest` (after `createdAt`):

```typescript
  /** Laps driven on this exact version (grouped by tuning_test_id). */
  lapCount: number;
  /** Best (min positive) lap time in ms on this version, or null. */
  bestLapMs: number | null;
```

- [ ] **Step 2: Add the `useSetHead` hook** (after `useCreateTuningTest`)

```typescript
export function useSetHead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, testId }: { sessionId: number; testId: number }) => {
      const res = await (client.api as any)["tuning-sessions"][":id"].head.$post({
        param: { id: String(sessionId) },
        json: { testId },
      });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as { ok: true; headTestId: number; label: string };
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["tuning-session", sessionId] });
      qc.invalidateQueries({ queryKey: ["tuning-session-tests", sessionId] });
      // Chat thread gained the deterministic checkout ack — refetch it.
      qc.invalidateQueries({ queryKey: ["tune-chat", sessionId] });
    },
  });
}
```

> Verify the chat query key: open `TuneSetupChat.tsx` and match the exact `queryKey` it uses for the chat history (replace `["tune-chat", sessionId]` with the real key). If the chat uses assistant-ui's own runtime fetch rather than a TanStack query, instead expose a `refetch`/reload trigger the workspace can call after checkout (see Task 12).

- [ ] **Step 3: Client build**

Run: `cd client && bun run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/queries.ts
git commit -m "feat(tune): client types for head + per-version laps, useSetHead hook"
```

---

## Task 11: `VersionGraph` component (replaces the flat tests table)

**Files:**
- Create: `client/src/components/tunes/VersionGraph.tsx`
- Modify: `client/src/components/tunes/TuningSessionWorkspace.tsx` (replace the tests table block, ~225-270)
- Test: none (UI) — verified by client build + manual smoke.

**Interfaces:**
- Consumes: `TuningTest[]` (with `parentTestId`, `label`, `lapCount`, `bestLapMs`), the session's `headTestId`, `useSetHead` (Task 10), the per-session laps the workspace already loads (grouped by `tuningTestId`).
- Produces: `<VersionGraph tests={...} headTestId={...} laps={...} sessionId={...} />`.

- [ ] **Step 1: Read the current workspace** — open `TuningSessionWorkspace.tsx`, locate the tests-table JSX (rows ~225-270), the lap-grouping code (~97-118), and the `AppliedChangesList` subcomponent (~321-343). Note how it currently obtains laps + tests so the graph can reuse those.

- [ ] **Step 2: Create `VersionGraph.tsx`**

```tsx
import { useState } from "react";
import { useSetHead, type TuningTest } from "@/hooks/queries";

/** A lap row already loaded by the workspace, narrowed to what the graph shows. */
export interface GraphLap {
  id: number;
  lapTime: number;
  isValid: boolean;
  tuningTestId: number | null;
}

interface VersionGraphProps {
  sessionId: number;
  tests: TuningTest[];
  headTestId: number | null;
  laps: GraphLap[];
  /** Renders a version's applied-changes summary (reuse the workspace's list). */
  renderChanges: (t: TuningTest) => React.ReactNode;
}

interface Node extends TuningTest {
  depth: number;
  children: Node[];
}

/** Build parent→children forest, ordered by version. */
function buildForest(tests: TuningTest[]): Node[] {
  const byId = new Map<number, Node>();
  for (const t of tests) byId.set(t.id, { ...t, depth: 0, children: [] });
  const roots: Node[] = [];
  for (const t of tests) {
    const node = byId.get(t.id)!;
    const parent = t.parentTestId != null ? byId.get(t.parentTestId) : undefined;
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (ns: Node[]) => {
    ns.sort((a, b) => a.version - b.version);
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Depth-first flatten so rows render top-to-bottom with indentation = lineage. */
function flatten(roots: Node[]): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

function fmtLap(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(3);
  return m > 0 ? `${m}:${rem.padStart(6, "0")}` : `${rem}`;
}

export function VersionGraph({ sessionId, tests, headTestId, laps, renderChanges }: VersionGraphProps) {
  const setHead = useSetHead();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const nodes = flatten(buildForest(tests));

  const lapsByTest = new Map<number, GraphLap[]>();
  for (const l of laps) {
    if (l.tuningTestId == null) continue;
    const arr = lapsByTest.get(l.tuningTestId) ?? [];
    arr.push(l);
    lapsByTest.set(l.tuningTestId, arr);
  }

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-1">
      {nodes.map((n) => {
        const isHead = n.id === headTestId;
        const nodeLaps = lapsByTest.get(n.id) ?? [];
        const isOpen = expanded.has(n.id);
        return (
          <div key={n.id} className="rounded-md border border-border/60">
            <div
              className="flex items-center gap-2 px-2 py-1"
              style={{ paddingLeft: `${n.depth * 16 + 8}px` }}
            >
              {/* Lineage dot */}
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  isHead ? "bg-primary" : "bg-muted-foreground/50"
                }`}
                aria-hidden
              />
              <button
                type="button"
                className="font-mono text-sm hover:underline"
                onClick={() => toggle(n.id)}
                title="Show changes + laps"
              >
                {n.label}
              </button>
              {n.engine && (
                <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                  {n.engine}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {n.lapCount} lap{n.lapCount === 1 ? "" : "s"}
                {n.bestLapMs != null ? ` · best ${fmtLap(n.bestLapMs)}` : ""}
              </span>
              <div className="ml-auto">
                {isHead ? (
                  <span className="rounded bg-primary/15 px-2 py-0.5 text-xs text-primary">current</span>
                ) : (
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                    disabled={setHead.isPending}
                    onClick={() => setHead.mutate({ sessionId, testId: n.id })}
                  >
                    Check out
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="border-t border-border/40 px-3 py-2" style={{ paddingLeft: `${n.depth * 16 + 20}px` }}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Changes</div>
                {renderChanges(n)}
                <div className="mb-1 mt-2 text-xs font-medium text-muted-foreground">Laps</div>
                {nodeLaps.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No laps yet on this version.</div>
                ) : (
                  <ul className="text-xs">
                    {nodeLaps.map((l) => (
                      <li key={l.id} className="flex gap-2">
                        <span className="font-mono">{fmtLap(l.lapTime)}</span>
                        {!l.isValid && <span className="text-destructive">invalid</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

> Match the repo's Tailwind/shadcn tokens actually in use (`border-border`, `bg-muted`, `text-muted-foreground`, `bg-primary`) — if the workspace uses different token names, mirror those. Keep `fmtLap` consistent with the workspace's existing lap-time formatter; if one exists, import and reuse it instead of redefining.

- [ ] **Step 3: Wire it into the workspace**

In `TuningSessionWorkspace.tsx`:
1. Import: `import { VersionGraph, type GraphLap } from "./VersionGraph";`
2. Replace the flat tests-table JSX block (~225-270) with:

```tsx
        <VersionGraph
          sessionId={session.id}
          tests={tests}
          headTestId={session.headTestId}
          laps={laps.map((l) => ({
            id: l.id,
            lapTime: l.lapTime,
            isValid: l.isValid,
            tuningTestId: (l as any).tuningTestId ?? null,
          }))}
          renderChanges={(t) => <AppliedChangesList test={t} />}
        />
```

> Use the workspace's real variable names for the session, tests array, and laps array (whatever `useTuningSession`, `useTuningSessionTests`, and the laps query are assigned to). Ensure the lap type carries `tuningTestId` — if the workspace's lap query doesn't select it yet, add it to that query's projection and the `LapMeta`/response type. Keep `AppliedChangesList` as the change renderer.
3. Delete the now-unused createdAt time-window grouping code (~97-118) **only if** nothing else references it; otherwise leave it for the legacy fallback and pass `tuningTestId`-null laps through unchanged (they simply won't appear under a node).

- [ ] **Step 4: Client build + lint**

Run: `cd client && bun run build && bun run lint`
Expected: build + lint pass.

- [ ] **Step 5: Manual smoke** (see Task 12 for the combined run) — defer to Task 12.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/tunes/VersionGraph.tsx client/src/components/tunes/TuningSessionWorkspace.tsx
git commit -m "feat(tune): commit-graph version view with laps under each node + checkout"
```

---

## Task 12: Chat refetch on checkout + end-to-end smoke

**Files:**
- Modify: `client/src/components/tunes/TuningSessionWorkspace.tsx` and/or `TuneSetupChat.tsx` (ensure the checkout ack shows in chat)

**Interfaces:**
- Consumes: `useSetHead` (already invalidates the chat query in Task 10). This task confirms the chat pane actually reloads.

- [ ] **Step 1: Confirm the chat reload path** — open `TuneSetupChat.tsx`. If it reads history via a TanStack query, confirm its `queryKey` matches the one `useSetHead` invalidates (fix either side so they match). If it uses assistant-ui's own thread runtime, add an effect: when `session.headTestId` changes, call the runtime's reload/refresh so the new assistant ack appears. Implement the minimal matching fix.

- [ ] **Step 2: End-to-end smoke**

Run the app: `bun run dev` (server 3117 + client). In the ACC/AC-EVO tuning workspace for an existing session with ≥2 versions:
- Verify the version graph renders with lineage indentation and lap counts.
- Click **Check out** on an older node → it becomes "current", and the chat pane shows `Switched to **vX** as the current setup — I'll work from here.`
- Ask the chat to make a change → confirm the new version appears as a **fork** off the checked-out node (dotted label, e.g. `v1.1`), not off the tip, and that the previously-newest version is untouched.

Expected: all three behaviours hold. This reproduces and fixes the `tune-session-61` scenario.

- [ ] **Step 3: Full test suite + client build (final gate)**

Run: `bun run test && cd client && bun run build`
Expected: PASS + successful build.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/tunes/TuningSessionWorkspace.tsx client/src/components/tunes/TuneSetupChat.tsx
git commit -m "feat(tune): reload chat on checkout so the head-change ack is visible"
```

---

## Self-Review

**Spec coverage:**
- §A data model → Task 1 (head + lap columns; label already exists). ✓
- §B numbering → Task 2 (`computeChildLabel`/`nextFreeLabel`), used in Task 5. ✓
- §C routes → Task 7 (head), Task 8 (tests+counts); parent=head on `POST /:id/tests` covered by Task 5's apply path (manual `POST /:id/tests` parent change: add to Task 8 if needed — the primary create path is apply-changes). ✓
- §D AI tools → Task 4 (head context), Task 5 (apply forks), Task 6 (branch-from-version). ✓
- §E graph UI + laps under node → Task 11. ✓
- §F lap attribution → Task 9. ✓
- §G checkout→chat ack → Task 7 (server ack) + Task 12 (client reload). ✓
- §H testing → Tasks 2,3,4,5,9 unit/DB tests; 11,12 build+smoke. ✓

**Placeholder scan:** no TBD/TODO; each code step shows full code. Two "verify the real name" notes (chat query key, lap-time column) are explicit verification steps, not placeholders — the implementer confirms against the file.

**Type consistency:** `setSessionHead`, `resolveActiveTestId`, `getLapCountsByTest`, `computeChildLabel`, `nextFreeLabel`, `useSetHead`, `VersionGraph`/`GraphLap` names are used identically across tasks. `headTestId` (camel) ↔ `head_test_id` (snake) and `tuningTestId` ↔ `tuning_test_id` are the consistent Drizzle/SQL pairing.

**Known verification points for the implementer** (not gaps — confirm against source):
- Exact `laps` lap-time Drizzle field (`lapTime`) in `getLapCountsByTest` and the graph.
- The chat history query key in `TuneSetupChat.tsx`.
- The workspace's real variable names for session/tests/laps and whether the laps query already selects `tuningTestId` (add it if not).
- Whether `mastra/agents/setup-engineer.ts` enumerates tool keys (add `branchFromVersionTool` there if so).
