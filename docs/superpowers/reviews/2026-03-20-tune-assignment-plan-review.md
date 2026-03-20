# Plan Review: Tune Assignment & AI Integration

**Reviewer:** Code Review Agent
**Date:** 2026-03-20
**Plan:** `docs/superpowers/plans/2026-03-20-tune-assignment.md`
**Spec:** `docs/superpowers/specs/2026-03-20-tune-assignment-design.md`

---

## Overall Assessment

The plan is well-structured, correctly ordered, and covers the spec thoroughly. The code provided is largely correct and complete. Below are the issues found, categorized by severity.

---

## Critical Issues (must fix)

### C1: `PATCH /api/laps/:id/tune` uses dynamic imports unnecessarily

**File:** Plan Task 7, `server/routes/tune-routes.ts` (lines 1149-1157)

The route handler uses dynamic `await import(...)` for `db`, `laps`, and `eq` inside the request handler. This is inconsistent with every other route in the codebase and creates unnecessary overhead per request.

**Fix:** Use static imports at the top of the file like every other query module:
```typescript
import { db } from "../db/index";
import { laps } from "../db/schema";
import { eq } from "drizzle-orm";
```

Or better: add a `updateLapTune(lapId, tuneId)` function to `tune-queries.ts` (keeping the query layer consistent) and call it from the route.

### C2: `getLapById` does not return `tuneId` -- analyse route will fail

**File:** Plan Task 7 Step 4

The plan says to access `lap.tuneId` in the analyse route (`const tune = lap.tuneId ? getTuneByIdFromDb(lap.tuneId) : null`), but the `getLapById` update in Task 3 Step 5 only says "Update `getLapById` similarly to include `tuneId` and `tuneName` via LEFT JOIN" without providing the actual code. This is too vague -- an implementer could easily miss adding `tuneId` to the select fields and the return object mapping.

**Fix:** Provide the complete `getLapById` code diff in Task 3 Step 5, just as the plan does for `getLaps`. Specifically:
- Add `tuneId: laps.tuneId` and `tuneName: tunes.name` to the `.select()`
- Switch from `innerJoin` to add a `.leftJoin(tunes, eq(laps.tuneId, tunes.id))`
- Add `tuneId` and `tuneName` to the return object mapping
- Import `tunes` from `./schema`

### C3: `routes.ts` has a duplicate `hasRecordedOutline` import that will cause a name collision

**File:** `server/routes.ts` (existing code, lines 18 and 35)

`hasRecordedOutline` is imported from both `./db/queries` (line 18) and `../shared/track-outlines/index` (line 35). This is an existing bug in the codebase, but the plan's new import of `getTuneById` (Task 7 Step 4) adds to an already fragile import block. The implementer should be made aware.

**Recommendation:** Note this in Task 7 to avoid confusion. The existing code works because the second import shadows the first, but it is technically a redeclaration.

---

## Important Issues (should fix)

### I1: Missing `Tune` type import in `routes.ts` analyse route

**File:** Plan Task 7 Step 4

The plan casts `parsedTune` as `Tune` (`as Tune`) but never shows importing the `Tune` type from `shared/types.ts` in `routes.ts`. The import block update should be:
```typescript
import { DRIVETRAIN_NAMES, type TelemetryPacket, type Tune } from "../shared/types";
```

### I2: `updateTune` uses `Record<string, any>` -- loses type safety

**File:** Plan Task 3, `server/db/tune-queries.ts` (line 473)

The `sets` accumulator is typed as `Record<string, any>`, and in the route handler the `data` passed to `updateTune` is also `Record<string, any>`. This bypasses the type checking that Drizzle provides.

**Fix:** Type `sets` as `Partial<typeof tunes.$inferInsert>` or at minimum use the same `InsertTuneData` partial type.

### I3: `POST /api/tunes/import` is functionally identical to `POST /api/tunes`

**File:** Plan Task 7, `tune-routes.ts` (lines 1051-1075)

The import endpoint accepts the exact same fields and performs the same validation as the create endpoint. The only difference is `source: "user"` which is already the default.

**Recommendation:** Either remove `/api/tunes/import` and use `POST /api/tunes` for both cases, or document what the intended differentiation is. If the import endpoint is meant for a different JSON structure (e.g., raw settings-only paste without metadata), the validation and field extraction should differ.

### I4: `setTuneAssignment` does not validate that `tuneId` exists

**File:** Plan Task 3, `tune-queries.ts` and Task 7 `PUT /api/tune-assignments` route

The assignment route passes `tuneId` directly to `setTuneAssignment` without checking that the tune exists. If the tune is later deleted, the CASCADE will clean up, but creating an assignment with a nonexistent `tuneId` will succeed (SQLite foreign key enforcement depends on `PRAGMA foreign_keys = ON`).

**Fix:** Either verify `PRAGMA foreign_keys = ON` is set in the Drizzle DB initialization, or add a `getTuneById(tuneId)` check in the route before calling `setTuneAssignment`.

### I5: Test cleanup does not handle foreign key ordering

**File:** Plan Task 3, `test/tune-queries.test.ts` (lines 309-312)

The `beforeEach` cleanup deletes from `tuneAssignments` then `tunes`. This works only if `tuneAssignments` CASCADE is active. But the test also needs to clean up `laps` that might reference tunes (via the `tuneId` FK with SET NULL). If any test adds laps with `tuneId`, the cleanup order matters. Additionally, if `laps` references `sessions`, and sessions aren't cleaned, test isolation could break.

**Recommendation:** Add a note that tests should be run against a test database or add session/lap cleanup if tests grow to cover that integration.

### I6: Schema push (`db:push`) is mentioned in both Task 2 Step 4 and Task 10 Step 1

**File:** Plan Tasks 2 and 10

Task 2 says to run `bun run db:push` right after schema changes, and Task 10 repeats it. Running it twice is harmless but confusing. Since the tune-queries tests (Task 3) need the tables to exist, the push in Task 2 is necessary. Task 10 should clarify it is a verification step, not a first-time push.

---

## Suggestions (nice to have)

### S1: Extract JSON parse/stringify into a helper

The pattern of parsing JSON columns on read (`JSON.parse(t.strengths)`) and stringifying on write (`JSON.stringify(strengths)`) appears in at least 5 places across tune-routes.ts. A `parseTuneRow(row)` helper would reduce duplication and prevent inconsistency.

### S2: Client Task 8 is underspecified compared to server tasks

Tasks 1-7 provide exact code. Task 8 (client Tune Manager UI) provides TanStack Query hooks but only describes the form component ("Create a form component with collapsible sections..."). For an agentic worker, this lack of specificity will lead to significant implementation variance.

**Recommendation:** At minimum, provide the component structure/skeleton, the shadcn components to use, and the form state management approach (controlled vs uncontrolled, or a form library).

### S3: Missing error response handling in client mutation hooks

All `useMutation` hooks call `.then(r => r.json())` without checking `r.ok`. A 400/404 response will parse successfully but contain `{ error: "..." }` instead of the expected data. The `onSuccess` callback will fire even on error responses.

**Fix:** Add `.then(r => { if (!r.ok) throw new Error(...); return r.json(); })` or use `onError` callbacks.

### S4: Consider adding a `tune-routes.test.ts` for route-level tests

The plan lists `test/tune-routes.test.ts` in the File Structure section but never provides its content or includes it in any task step. The DB query tests are good but do not cover validation logic, JSON parsing/serializing in routes, or HTTP status codes.

### S5: Task ordering for `mkdir -p server/routes`

Task 7 Step 3 says to run `mkdir -p server/routes` but this is listed AFTER Step 1 (create the file) and Step 2 (mount it). The directory creation should be Step 1.

---

## Spec Coverage Checklist

| Spec Requirement | Plan Coverage | Status |
|---|---|---|
| Tune CRUD (create, read, update, delete) | Task 3 + Task 7 | Covered |
| JSON import | Task 7 `/api/tunes/import` | Covered |
| Catalog clone | Task 7 `/api/tunes/clone/:catalogId` | Covered |
| Catalog read-only endpoint | Task 7 `/api/catalog/tunes` | Covered |
| Tune assignments CRUD | Task 3 + Task 7 | Covered |
| Lap tune snapshot on save | Task 6 | Covered |
| Per-lap tune override | Task 7 PATCH + Task 9 UI | Covered |
| AI prompt integration | Task 4 + Task 5 | Covered |
| System prompt update for tune-aware advice | Task 5 Step 3 | Covered |
| Shared types moved to `shared/types.ts` | Task 1 | Covered |
| `LapMeta` updated with `tuneId`/`tuneName` | Task 1 | Covered |
| `getLaps`/`getLapById` LEFT JOIN tunes | Task 3 Step 5 | Partially (getLapById vague) |
| Validation of `TuneSettings` on write paths | Task 7 `validateTuneSettings` | Covered |
| Tune Manager UI | Task 8 | Covered (underspecified) |
| Per-lap override UI in LapAnalyse | Task 9 | Covered |
| Tune badge in lap list | Task 9 Step 2 | Covered |
| Visual differentiation default vs override | Task 9 Step 1 | Mentioned, not detailed |
| Migration strategy (nullable column, existing laps unaffected) | Task 2 | Covered |
| `tunes` table schema matches spec | Task 2 Step 1 | Covered |
| `tuneAssignments` table schema matches spec | Task 2 Step 2 | Covered |
| `laps.tuneId` FK with SET NULL | Task 2 Step 3 | Covered |

---

## Dependency Order Verification

The task ordering is correct:
1. Types first (Task 1) -- no dependencies
2. Schema (Task 2) -- needs types for reference only
3. DB queries (Task 3) -- needs schema from Task 2
4. Tune formatting (Task 4) -- needs types from Task 1
5. AI prompt (Task 5) -- needs formatter from Task 4
6. Lap detector (Task 6) -- needs queries from Task 3
7. API routes (Task 7) -- needs queries from Task 3, prompt from Task 5
8. Client tune UI (Task 8) -- needs API from Task 7
9. Client lap override (Task 9) -- needs API from Task 7, types from Task 1
10. E2E verification (Task 10) -- needs everything

One minor issue: Task 7 Step 4 modifies the analyse route to use `lap.tuneId`, which requires the `getLapById` changes from Task 3 Step 5. This dependency is satisfied by the ordering.

---

## Summary

The plan is **ready for implementation with targeted fixes**. The 3 critical issues (C1-C3) should be addressed before handing to an implementer. The important issues (I1-I6) should be fixed to avoid bugs during implementation. The suggestions are quality improvements that can be addressed during or after implementation.

**Estimated effort to fix:** ~30 minutes of plan editing.
