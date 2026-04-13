# Remove File-Based Recorded Outlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the file-based recorded outline CSV system from `shared/track-data.ts` and consolidate on the DB-backed outline system that already exists in `server/db/queries.ts`, with bundled centerlines as the primary source.

**Architecture:** Two outline sources remain: (1) bundled centerlines shipped in `shared/track-outlines/{game}/centerline-*.csv` for all known tracks, (2) DB `track_outlines` table for tracks discovered at runtime via telemetry. The file-based `recorded-*.csv` system, `scanRecordedFiles`, `recordLapTrace`, and the in-memory `lapTraces`/`recordedOutlines` caches are removed entirely. `lap-detector.ts` already saves to DB via `accumulateLapForOutline()` — only the redundant `recordLapTrace()` call is removed.

**Tech Stack:** Bun, Drizzle ORM (SQLite), Hono routes

---

### Background: Two Parallel Systems

The lap detector currently runs **two** outline recording systems on each lap:

1. **`recordLapTrace()`** (line 352) → writes `recorded-{ordinal}.csv` to disk, managed in `shared/track-data.ts` — **REMOVING THIS**
2. **`accumulateLapForOutline()`** (line 453) → saves averaged outline to DB via `saveTrackOutline()` — **KEEPING THIS**

The DB system already handles averaging, smoothing, start-line rotation, speed data, and sector computation. The file system is redundant.

### Outline Priority After Migration

1. **Bundled centerlines** (`shared/track-outlines/{game}/centerline-{ordinal}.csv`) — shipped with app
2. **DB outlines** (`track_outlines` table) — built from telemetry for unknown tracks
3. **Shared TUMFTM** (real-world reference outlines) — cross-game fallback

---

### Task 1: Remove `recordLapTrace` call from lap-detector

**Files:**
- Modify: `server/lap-detector.ts:15,340-353`

- [ ] **Step 1: Remove the import and call**

In `server/lap-detector.ts`, remove `recordLapTrace` from the import at line 15:

```typescript
// Before:
import { hasTrackOutline, recordLapTrace, extractCurbSegments, recordCurbData } from "../shared/track-data";

// After:
import { hasTrackOutline, extractCurbSegments, recordCurbData } from "../shared/track-data";
```

Remove the trace extraction and `recordLapTrace` call at lines 338-353. Delete this entire block:

```typescript
      // Extract position trace for track outline recording
      const trace: { x: number; z: number }[] = [];
      for (let i = 0; i < this.lapBuffer.length; i += 6) {
        const p = this.lapBuffer[i];
        if (p.PositionX !== 0 || p.PositionZ !== 0) {
          trace.push({ x: p.PositionX, z: p.PositionZ });
        }
      }
      // Start-line position and yaw: where the car is when the new lap begins
      const startLinePos = (newLapFirstPacket.PositionX !== 0 || newLapFirstPacket.PositionZ !== 0)
        ? { x: newLapFirstPacket.PositionX, z: newLapFirstPacket.PositionZ }
        : null;
      const startYaw = newLapFirstPacket.Yaw;
      if (trace.length > 50) {
        recordLapTrace(this.currentSession.trackOrdinal, trace, startLinePos, startYaw, this.currentSession.gameId);
      }
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All 66 tests pass

- [ ] **Step 3: Commit**

```bash
git add server/lap-detector.ts
git commit -m "Remove redundant recordLapTrace call from lap detector"
```

---

### Task 2: Remove file-based outline functions from shared/track-data.ts

**Files:**
- Modify: `shared/track-data.ts`

This task removes the entire file-based recorded outline system. The functions to remove:

- `recordLapTrace` (exported, line 707-813) — CSV writer + in-memory averaging
- `loadRecordedOutline` (internal, line 440-459) — CSV reader
- `scanRecordedFiles` (exported, line 411-428) — file index scanner
- `ensureRecordedScanned` (internal, line 432) — lazy init
- `deleteRecordedOutline` (exported, line 859-892) — file + cache deletion
- `hasRecordedOutline` (exported, line 825-829) — file existence check
- `getStartYaw` (exported, line 846-853) — start-line yaw from in-memory accumulator
- `hasExtractedOutline` (internal, line 434-437) — extracted file check
- `filterOutlierPoints` (internal, line 669-693) — used only by recordLapTrace

Also remove the in-memory state these depend on:

- `recordedOutlines` TTL cache (line 403)
- `recordedLapCounts` Map (line 404)
- `recordedOrdinals` Set (line 405)
- `_recordedScanned` flag (line 409)
- `lapTraces` Map (line 658)
- `startLinePositions` Map (line 660)
- `startLineYaws` Map (line 662)

- [ ] **Step 1: Remove in-memory state variables**

Delete these lines (approximately 395-409 and 657-662):

```typescript
const recordedOutlines = ttlCache<Point[]>();
const recordedLapCounts = new Map<string, number>();
const recordedOrdinals = new Set<string>();

function gk(gameId: string, ordinal: number): string { return `${gameId}:${ordinal}`; }

let _recordedScanned = false;
```

```typescript
const lapTraces = new Map<string, Point[][]>();
const startLinePositions = new Map<string, Point[]>();
const startLineYaws = new Map<string, number[]>();
```

- [ ] **Step 2: Remove functions**

Delete these functions entirely:

- `scanRecordedFiles()` (~line 411-428)
- `ensureRecordedScanned()` (~line 432)
- `hasExtractedOutline()` (~line 434-437)
- `loadRecordedOutline()` (~line 440-459)
- `filterOutlierPoints()` (~line 669-693)
- `recordLapTrace()` (~line 707-813)
- `hasRecordedOutline()` (~line 825-829)
- `getStartYaw()` (~line 846-853)
- `deleteRecordedOutline()` (~line 859-892)

- [ ] **Step 3: Update `getTrackOutlineByOrdinal`**

The current implementation (line 820-822):

```typescript
export function getTrackOutlineByOrdinal(ordinal: number, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  return loadRecordedOutline(ordinal, gameId) ?? loadSharedOutline(sharedName ?? "") ?? getBundledOutlineByOrdinal(ordinal);
}
```

Replace with bundled centerline as primary source (no more `loadRecordedOutline`):

```typescript
export function getTrackOutlineByOrdinal(ordinal: number, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  return loadBundledCenterline(ordinal, gameId) ?? loadSharedOutline(sharedName ?? "") ?? getBundledOutlineByOrdinal(ordinal);
}
```

- [ ] **Step 4: Add `loadBundledCenterline` function**

Replace the removed `loadRecordedOutline` with a simple bundled-only loader:

```typescript
/** Load bundled game centerline from shared/track-outlines/{game}/centerline-{ordinal}.csv */
function loadBundledCenterline(ordinal: number, gameId: string): Point[] | null {
  const filePath = resolve(bundledOutlineDir, gameId, `centerline-${ordinal}.csv`);
  const content = readDataFile(filePath);
  if (!content) return null;
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    return data.length > 10 ? data : null;
  } catch { return null; }
}
```

- [ ] **Step 5: Update `hasTrackOutline` to use bundled check**

Replace:
```typescript
export function hasTrackOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  ensureOrdinals();
  return hasRecordedOutline(ordinal, gameId) || outlineOrdinals.has(ordinal);
}
```

With:
```typescript
export function hasTrackOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  return hasBundledCenterline(ordinal, gameId) || hasBundledOutline(ordinal);
}
```

Add helper:
```typescript
/** Check if a bundled game centerline exists. */
export function hasBundledCenterline(ordinal: number, gameId: string): boolean {
  return existsSync(resolve(bundledOutlineDir, gameId, `centerline-${ordinal}.csv`));
}
```

Rename `outlineOrdinals.has()` check to `hasBundledOutline()` for clarity, or keep the existing shared/TUMFTM ordinal set (read the `ensureOrdinals` function to decide — it may already be named fine).

- [ ] **Step 6: Update `loadExtractedBoundary` alignment fallback**

The alignment code at ~line 601-614 reads the extracted centerline and a telemetry-recorded outline to align boundaries. Remove the telemetry alignment since we no longer have recorded outlines — bundled data is already aligned:

```typescript
// Before: tries to align extracted boundaries to telemetry recordings
const extContent = readDataFile(resolve(userDir, gameId, "extracted", `recorded-${ordinal}.csv`))
  ?? readDataFile(resolve(bundledOutlineDir, gameId, `centerline-${ordinal}.csv`));
const telContent = readDataFile(resolve(userDir, gameId, `recorded-${ordinal}.csv`));

// After: boundaries from bundled data are pre-aligned, no runtime alignment needed
// Remove the entire if (!data.aligned) { ... } block
```

- [ ] **Step 7: Remove exports from module**

Remove these from the module's export list (if explicitly exported):
- `recordLapTrace`
- `scanRecordedFiles`
- `deleteRecordedOutline`
- `hasRecordedOutline`
- `getStartYaw`

- [ ] **Step 8: Run tests**

Run: `bun test`
Expected: All tests pass (may need to fix test imports if any test references removed functions)

- [ ] **Step 9: Commit**

```bash
git add shared/track-data.ts
git commit -m "Remove file-based recorded outline system from track-data"
```

---

### Task 3: Update track-routes.ts to use DB outlines instead of file-based

**Files:**
- Modify: `server/routes/track-routes.ts`

- [ ] **Step 1: Update imports**

Remove imports of deleted functions:
```typescript
// Remove these imports from shared/track-data:
import {
  hasRecordedOutline as sharedHasRecordedOutline,  // REMOVE
  deleteRecordedOutline,                             // REMOVE
  getStartYaw,                                       // REMOVE
  // ... keep the rest
} from "../../shared/track-data";
```

Add/keep the DB import:
```typescript
import { getTrackOutline as getDbTrackOutline, hasRecordedOutline as hasDbOutline } from "../db/queries";
```

- [ ] **Step 2: Update GET /api/track-outline/:ordinal (line 929-959)**

Current code checks file-based first, then DB, then shared. Simplify to: bundled centerline → DB → shared.

```typescript
.get("/api/track-outline/:ordinal",
  zValidator("param", OrdinalParamSchema),
  zValidator("query", GameIdQuerySchema),
  (c) => {
    const { ordinal } = c.req.valid("param");
    const gameId = c.req.query("gameId");
    const sharedName = getSharedTrackName(ordinal, gameId);
    const altitude = getTrackAltitudeByOrdinal(ordinal);

    // 1. Bundled centerlines (shipped with app)
    const bundled = getTrackOutlineByOrdinal(ordinal, gameId ?? "fm-2023", sharedName);
    if (bundled) {
      return c.json({ points: bundled, recorded: false, source: "extracted", ...(altitude && { altitude }) });
    }

    // 2. DB-recorded outlines (from telemetry)
    if (gameId) {
      const dbOutline = getDbTrackOutline(ordinal, gameId as GameId);
      if (dbOutline) return c.json({ points: dbOutline, recorded: true, source: "recorded", ...(altitude && { altitude }) });
    }

    // 3. Shared outlines (cross-game TUMFTM)
    if (sharedName) {
      const shared = loadSharedOutline(sharedName);
      if (shared) return c.json({ points: shared, recorded: false, source: "tumftm" });
    }

    return c.json({ error: "No outline available" }, 404);
  }
)
```

Note: `startYaw` is removed from the response since `getStartYaw` is gone. Check if the client uses it — if so, compute it from the DB outline's first point direction instead.

- [ ] **Step 3: Update DELETE /api/track-outline/:ordinal (line 962-970)**

Replace `deleteRecordedOutline` with DB deletion. Add a `deleteTrackOutline` function to `server/db/queries.ts` if it doesn't exist:

```typescript
.delete("/api/track-outline/:ordinal",
  zValidator("param", OrdinalParamSchema),
  (c) => {
    const { ordinal } = c.req.valid("param");
    const gameId = requireGameId(c);
    const deleted = deleteDbTrackOutline(ordinal, gameId as GameId);
    return c.json({ success: true, hadRecorded: deleted });
  }
)
```

- [ ] **Step 4: Update track listing endpoints (lines 355-410)**

Replace `sharedHasRecordedOutline(ordinal, gameId)` calls with `hasBundledCenterline(ordinal, gameId) || hasDbOutline(ordinal, gameId)`. There are calls at approximately lines 364, 386, 406, 408.

- [ ] **Step 5: Remove `startYaw` from any response**

Search for `startYaw` in track-routes.ts and remove from all response objects. If the client uses this for a direction arrow, we can derive it from the outline's first two points later — but remove it now.

- [ ] **Step 6: Run tests and build**

Run: `bun test && cd client && bun run build`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add server/routes/track-routes.ts server/db/queries.ts
git commit -m "Switch track routes from file-based to DB outlines"
```

---

### Task 4: Add `deleteTrackOutline` to DB queries

**Files:**
- Modify: `server/db/queries.ts`

- [ ] **Step 1: Add delete function**

```typescript
/** Delete a track outline from the database. Returns true if a row was deleted. */
export function deleteTrackOutline(
  trackOrdinal: number,
  gameId: GameId
): boolean {
  const existing = db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (!existing) return false;

  db.delete(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .run();

  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/db/queries.ts
git commit -m "Add deleteTrackOutline DB query"
```

---

### Task 5: Update misc-routes.ts — remove scanRecordedFiles calls

**Files:**
- Modify: `server/routes/misc-routes.ts`

- [ ] **Step 1: Remove import and calls**

Remove `scanRecordedFiles` from the import:
```typescript
// Remove:
import { scanRecordedFiles } from "../../shared/track-data";
```

Remove all calls to `scanRecordedFiles()` at lines ~199, ~309, ~407, ~435. These were called after extraction to rebuild the file index — no longer needed since bundled centerlines are loaded directly.

- [ ] **Step 2: Run tests and build**

Run: `bun test && cd client && bun run build`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add server/routes/misc-routes.ts
git commit -m "Remove scanRecordedFiles calls from misc routes"
```

---

### Task 6: Clean up readUserOrBundled — remove extracted/ path handling

**Files:**
- Modify: `shared/track-data.ts`

- [ ] **Step 1: Simplify readUserOrBundled**

Now that we don't read `extracted/` files via this function, simplify it:

```typescript
/** Read a file from bundled track outlines. */
function readBundledFile(gameId: string, filename: string): string | null {
  return readDataFile(resolve(bundledOutlineDir, gameId, filename));
}
```

Update callers (`loadExtractedSegments`, `getTrackAltitudeByOrdinal`) to use `readBundledFile` directly with the correct filename (no `extracted/` prefix):

```typescript
// loadExtractedSegments: 
const content = readBundledFile(gameId, `segments-${ordinal}.json`);

// getTrackAltitudeByOrdinal:
const content = readBundledFile("fm-2023", `boundaries-${ordinal}.json`);
```

- [ ] **Step 2: Remove userDir references for outline reading**

If `readUserOrBundled` is no longer called, remove it entirely and the `userDir` constant if it's only used for outline file paths. Check if `userDir` / `userGameDir` is still needed for curb data — if so, keep it for that purpose only.

- [ ] **Step 3: Run tests and build**

Run: `bun test && cd client && bun run build`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add shared/track-data.ts
git commit -m "Simplify track data to read bundled outlines only"
```

---

### Task 7: Client cleanup — derive startYaw from outline

**Files:**
- Modify: `client/src/components/LiveTrackMap.tsx`

`LiveTrackMap.tsx` uses `startYaw` from the API response to draw a direction arrow at the start/finish line (lines 36, 86, 90, 124, 430-434). Since we're removing the server-side `getStartYaw()` accumulator, derive direction from the outline's first two points instead.

- [ ] **Step 1: Compute direction from outline points**

In `LiveTrackMap.tsx`, where `startYaw` is read from the API response (~lines 86-90, 124), replace with a computed value from the outline's first two points:

```typescript
// After setting outline points, compute direction from first two points:
if (points.length >= 2) {
  const dx = points[1].x - points[0].x;
  const dz = points[1].z - points[0].z;
  setStartYaw(Math.atan2(-dx, dz));
} else {
  setStartYaw(null);
}
```

Remove the `data.startYaw` reads.

- [ ] **Step 2: Run build**

Run: `cd client && bun run build`
Expected: Build succeeds

- [ ] **Step 3: Commit (if changes made)**

```bash
git add client/src/
git commit -m "Remove startYaw from client track outline handling"
```

---

### Task 8: Delete recorded CSV files from user data

**Files:**
- No code changes — data cleanup

- [ ] **Step 1: Document that existing recorded-*.csv files in data/userdata/ are now unused**

These files can be safely deleted by users. The app no longer reads them. No automatic cleanup needed ��� the `data/` directory is gitignored and user-local.

- [ ] **Step 2: Final full test and build**

```bash
bun test && cd client && bun run build
```

- [ ] **Step 3: Final commit with all remaining changes**

```bash
git add -A
git commit -m "Complete migration from file-based to DB+bundled track outlines"
```
