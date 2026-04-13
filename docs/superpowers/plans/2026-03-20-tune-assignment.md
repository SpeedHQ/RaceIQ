# Tune Assignment & AI Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create/manage car tunes, assign them to car+track combos, snapshot the active tune per lap, and pass tune settings to AI analysis.

**Architecture:** New `tunes` and `tuneAssignments` DB tables, new `tuneId` column on `laps`. Tune CRUD + assignment + catalog clone API routes. Lap detector snapshots active tune at save time. AI prompt builder receives optional tune for prompt enrichment. Existing static catalog stays read-only alongside user tunes.

**Tech Stack:** Bun, Hono, Drizzle ORM + SQLite, React 19, TanStack Router/Query, shadcn, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-03-20-tune-assignment-design.md`

---

## File Structure

### New files
- `server/db/tune-queries.ts` — All tune + assignment DB query helpers
- `server/routes/tune-routes.ts` — Hono route handlers for tune CRUD, assignments, catalog
- `server/ai/format-tune.ts` — Format `TuneSettings` into human-readable text for AI prompt
- `test/tune-queries.test.ts` — Tests for tune DB queries
- `test/format-tune.test.ts` — Tests for tune formatting
- `test/tune-routes.test.ts` — Tests for tune API routes

### Modified files
- `shared/types.ts` — Add `TuneSettings`, `RaceStrategy`, `Tune`, `TuneAssignment` types; update `LapMeta`
- `server/db/schema.ts` — Add `tunes`, `tuneAssignments` tables; add `tuneId` to `laps`
- `server/db/queries.ts` — Update `insertLap`, `getLaps`, `getLapById` to handle `tuneId`/`tuneName`
- `server/lap-detector.ts` — Snapshot active tune on lap save
- `server/ai/analyst-prompt.ts` — Accept optional `Tune`, inject into prompt + update system prompt
- `server/routes.ts` — Import and mount tune routes
- `client/src/data/tune-catalog.ts` — Re-export `TuneSettings` from `shared/types.ts` instead of defining locally
- `client/src/components/TuneCatalog.tsx` — Extend with user tunes, clone, assignment UI
- `client/src/components/LapAnalyse.tsx` — Add per-lap tune override dropdown

---

## Task 1: Shared Types

**Files:**
- Modify: `shared/types.ts`
- Modify: `client/src/data/tune-catalog.ts`

- [ ] **Step 1: Add TuneSettings and RaceStrategy to shared/types.ts**

Move `TuneSettings` and `RaceStrategy` interfaces from `client/src/data/tune-catalog.ts` to `shared/types.ts`. Add `Tune`, `TuneAssignment`, and `TuneCategory` types. Update `LapMeta` with optional `tuneId` and `tuneName`.

Add to `shared/types.ts`:

```typescript
export type TuneCategory = 'circuit' | 'wet' | 'low-drag' | 'stable' | 'track-specific';

export interface TuneSettings {
  tires: {
    frontPressure: number;
    rearPressure: number;
    compound?: string;
  };
  gearing: {
    finalDrive: number;
    ratios?: number[];
    description?: string;
  };
  alignment: {
    frontCamber: number;
    rearCamber: number;
    frontToe: number;
    rearToe: number;
    frontCaster?: number;
  };
  antiRollBars: {
    front: number;
    rear: number;
  };
  springs: {
    frontRate: number;
    rearRate: number;
    frontHeight: number;
    rearHeight: number;
    unit?: string;
  };
  damping: {
    frontRebound: number;
    rearRebound: number;
    frontBump: number;
    rearBump: number;
  };
  aero: {
    frontDownforce: number;
    rearDownforce: number;
    unit?: string;
  };
  differential: {
    frontAccel?: number;
    frontDecel?: number;
    rearAccel: number;
    rearDecel: number;
    center?: number;
  };
  brakes: {
    balance: number;
    pressure: number;
  };
}

export interface RaceStrategy {
  condition: "Dry" | "Wet";
  totalLaps: number;
  fuelLoadPercent: number;
  tireCompound: string;
  pitStops: number;
  pitLaps?: number[];
  notes?: string;
}

export interface Tune {
  id: number;
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: RaceStrategy[];
  settings: TuneSettings;
  source: 'user' | 'catalog-clone';
  catalogId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TuneAssignment {
  carOrdinal: number;
  trackOrdinal: number;
  tuneId: number;
  tuneName?: string;
}
```

Update `LapMeta`:
```typescript
export interface LapMeta {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  createdAt: string;
  pi?: number;
  carOrdinal?: number;
  trackOrdinal?: number;
  tuneId?: number;
  tuneName?: string;
}
```

- [ ] **Step 2: Update tune-catalog.ts to re-export from shared**

In `client/src/data/tune-catalog.ts`, replace the local `TuneSettings` and `RaceStrategy` interface definitions with re-exports:

```typescript
export type { TuneSettings, RaceStrategy } from "@shared/types";
```

Keep `CatalogTune`, `CatalogCar`, and the catalog data/functions as-is.

- [ ] **Step 3: Verify client builds**

Run: `cd client && bun run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts client/src/data/tune-catalog.ts
git commit -m "feat: add shared Tune types and update LapMeta with tuneId"
```

---

## Task 2: Database Schema

**Files:**
- Modify: `server/db/schema.ts`

- [ ] **Step 1: Add tunes table to schema**

Add after the `profiles` table definition in `server/db/schema.ts`:

```typescript
export const tunes = sqliteTable(
  "tunes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    author: text("author").notNull(),
    carOrdinal: integer("car_ordinal").notNull(),
    category: text("category").notNull(), // 'circuit' | 'wet' | 'low-drag' | 'stable' | 'track-specific'
    trackOrdinal: integer("track_ordinal"),
    description: text("description").notNull().default(""),
    strengths: text("strengths"), // JSON array
    weaknesses: text("weaknesses"), // JSON array
    bestTracks: text("best_tracks"), // JSON array
    strategies: text("strategies"), // JSON array of RaceStrategy
    settings: text("settings").notNull(), // JSON TuneSettings
    source: text("source").notNull().default("user"), // 'user' | 'catalog-clone'
    catalogId: text("catalog_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    carIdx: index("idx_tunes_car").on(table.carOrdinal),
  })
);
```

- [ ] **Step 2: Add tuneAssignments table**

Add after the `tunes` table:

```typescript
export const tuneAssignments = sqliteTable(
  "tune_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    carOrdinal: integer("car_ordinal").notNull(),
    trackOrdinal: integer("track_ordinal").notNull(),
    tuneId: integer("tune_id")
      .notNull()
      .references(() => tunes.id, { onDelete: "cascade" }),
  },
  (table) => ({
    carTrackUnique: unique().on(table.carOrdinal, table.trackOrdinal),
    tuneIdx: index("idx_assignments_tune").on(table.tuneId),
  })
);
```

- [ ] **Step 3: Add tuneId column to laps table**

Add to the `laps` table columns, after `pi`:

```typescript
tuneId: integer("tune_id").references(() => tunes.id, { onDelete: "set null" }),
```

- [ ] **Step 4: Push schema to database**

Run: `bun run db:push`
Expected: Schema pushed successfully, new tables created, laps table altered.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.ts
git commit -m "feat: add tunes and tuneAssignments tables, add tuneId to laps"
```

---

## Task 3: Tune DB Queries

**Files:**
- Create: `server/db/tune-queries.ts`
- Create: `test/tune-queries.test.ts`
- Modify: `server/db/queries.ts`

- [ ] **Step 1: Write failing tests for tune CRUD queries**

Create `test/tune-queries.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../server/db/index";
import { tunes, tuneAssignments, laps, sessions } from "../server/db/schema";
import { sql } from "drizzle-orm";
import {
  insertTune,
  getTunes,
  getTuneById,
  updateTune,
  deleteTune,
  setTuneAssignment,
  getTuneAssignment,
  getTuneAssignments,
  deleteTuneAssignment,
} from "../server/db/tune-queries";

const TEST_SETTINGS = JSON.stringify({
  tires: { frontPressure: 30.5, rearPressure: 31.0 },
  gearing: { finalDrive: 3.42 },
  alignment: { frontCamber: -1.2, rearCamber: -0.8, frontToe: 0, rearToe: 0.1 },
  antiRollBars: { front: 22.4, rear: 18.6 },
  springs: { frontRate: 750, rearRate: 680, frontHeight: 5.2, rearHeight: 5.4 },
  damping: { frontRebound: 8.2, rearRebound: 7.4, frontBump: 5.1, rearBump: 4.8 },
  aero: { frontDownforce: 185, rearDownforce: 220 },
  differential: { rearAccel: 72, rearDecel: 45 },
  brakes: { balance: 54, pressure: 95 },
});

// Clean test data between tests
beforeEach(() => {
  db.delete(tuneAssignments).run();
  db.delete(tunes).run();
});

describe("tune CRUD", () => {
  test("insertTune creates and returns tune with id", () => {
    const id = insertTune({
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    expect(id).toBeGreaterThan(0);
  });

  test("getTuneById returns inserted tune", () => {
    const id = insertTune({
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    const tune = getTuneById(id);
    expect(tune).not.toBeNull();
    expect(tune!.name).toBe("Test Tune");
    expect(tune!.carOrdinal).toBe(2860);
  });

  test("getTunes filters by carOrdinal", () => {
    insertTune({ name: "A", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    insertTune({ name: "B", author: "t", carOrdinal: 200, category: "wet", description: "", settings: TEST_SETTINGS });
    const filtered = getTunes(100);
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("A");
  });

  test("updateTune modifies fields", () => {
    const id = insertTune({ name: "Old", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const updated = updateTune(id, { name: "New" });
    expect(updated).toBe(true);
    expect(getTuneById(id)!.name).toBe("New");
  });

  test("deleteTune removes tune", () => {
    const id = insertTune({ name: "X", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    expect(deleteTune(id)).toBe(true);
    expect(getTuneById(id)).toBeNull();
  });
});

describe("tune assignments", () => {
  test("setTuneAssignment creates assignment", () => {
    const tuneId = insertTune({ name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, tuneId);
    const assignment = getTuneAssignment(100, 500);
    expect(assignment).not.toBeNull();
    expect(assignment!.tuneId).toBe(tuneId);
  });

  test("setTuneAssignment upserts on same car+track", () => {
    const id1 = insertTune({ name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = insertTune({ name: "T2", author: "t", carOrdinal: 100, category: "wet", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, id1);
    setTuneAssignment(100, 500, id2);
    const assignment = getTuneAssignment(100, 500);
    expect(assignment!.tuneId).toBe(id2);
  });

  test("deleteTuneAssignment removes assignment", () => {
    const tuneId = insertTune({ name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, tuneId);
    expect(deleteTuneAssignment(100, 500)).toBe(true);
    expect(getTuneAssignment(100, 500)).toBeNull();
  });

  test("getTuneAssignments filters by carOrdinal", () => {
    const id1 = insertTune({ name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = insertTune({ name: "T2", author: "t", carOrdinal: 200, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, id1);
    setTuneAssignment(200, 600, id2);
    const all = getTuneAssignments();
    expect(all.length).toBe(2);
    const filtered = getTuneAssignments(100);
    expect(filtered.length).toBe(1);
    expect(filtered[0].tuneName).toBe("T1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tune-queries.test.ts`
Expected: FAIL — `tune-queries` module not found.

- [ ] **Step 3: Implement tune-queries.ts**

Create `server/db/tune-queries.ts`:

```typescript
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "./index";
import { tunes, tuneAssignments, laps } from "./schema";

interface InsertTuneData {
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number;
  description: string;
  strengths?: string;   // JSON string
  weaknesses?: string;  // JSON string
  bestTracks?: string;  // JSON string
  strategies?: string;  // JSON string
  settings: string;     // JSON string
  source?: string;
  catalogId?: string;
}

export function insertTune(data: InsertTuneData): number {
  const result = db
    .insert(tunes)
    .values({
      name: data.name,
      author: data.author,
      carOrdinal: data.carOrdinal,
      category: data.category,
      trackOrdinal: data.trackOrdinal ?? null,
      description: data.description,
      strengths: data.strengths ?? null,
      weaknesses: data.weaknesses ?? null,
      bestTracks: data.bestTracks ?? null,
      strategies: data.strategies ?? null,
      settings: data.settings,
      source: data.source ?? "user",
      catalogId: data.catalogId ?? null,
    })
    .returning({ id: tunes.id })
    .get();
  return result.id;
}

export function getTunes(carOrdinal?: number) {
  const query = db
    .select()
    .from(tunes)
    .orderBy(desc(tunes.id));

  if (carOrdinal != null) {
    return query.where(eq(tunes.carOrdinal, carOrdinal)).all();
  }
  return query.all();
}

export function getTuneById(id: number) {
  return db.select().from(tunes).where(eq(tunes.id, id)).get() ?? null;
}

export function updateTune(id: number, data: Partial<Omit<InsertTuneData, "carOrdinal">> & { carOrdinal?: number }): boolean {
  const sets: Record<string, any> = { updatedAt: sql`(datetime('now'))` };
  if (data.name !== undefined) sets.name = data.name;
  if (data.author !== undefined) sets.author = data.author;
  if (data.carOrdinal !== undefined) sets.carOrdinal = data.carOrdinal;
  if (data.category !== undefined) sets.category = data.category;
  if (data.trackOrdinal !== undefined) sets.trackOrdinal = data.trackOrdinal;
  if (data.description !== undefined) sets.description = data.description;
  if (data.strengths !== undefined) sets.strengths = data.strengths;
  if (data.weaknesses !== undefined) sets.weaknesses = data.weaknesses;
  if (data.bestTracks !== undefined) sets.bestTracks = data.bestTracks;
  if (data.strategies !== undefined) sets.strategies = data.strategies;
  if (data.settings !== undefined) sets.settings = data.settings;

  const result = db.update(tunes).set(sets).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export function deleteTune(id: number): boolean {
  const result = db.delete(tunes).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export function setTuneAssignment(carOrdinal: number, trackOrdinal: number, tuneId: number): void {
  const existing = db
    .select({ id: tuneAssignments.id })
    .from(tuneAssignments)
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();

  if (existing) {
    db.update(tuneAssignments)
      .set({ tuneId })
      .where(eq(tuneAssignments.id, existing.id))
      .run();
  } else {
    db.insert(tuneAssignments)
      .values({ carOrdinal, trackOrdinal, tuneId })
      .run();
  }
}

export function getTuneAssignment(carOrdinal: number, trackOrdinal: number) {
  const row = db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id))
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();
  return row ?? null;
}

export function getTuneAssignments(carOrdinal?: number) {
  const query = db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id));

  if (carOrdinal != null) {
    return query.where(eq(tuneAssignments.carOrdinal, carOrdinal)).all();
  }
  return query.all();
}

export function deleteTuneAssignment(carOrdinal: number, trackOrdinal: number): boolean {
  const result = db
    .delete(tuneAssignments)
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .returning()
    .all();
  return result.length > 0;
}

export function updateLapTune(lapId: number, tuneId: number | null): boolean {
  const result = db
    .update(laps)
    .set({ tuneId })
    .where(eq(laps.id, lapId))
    .returning()
    .all();
  return result.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tune-queries.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Update insertLap, getLaps, getLapById in queries.ts**

In `server/db/queries.ts`:

Update `insertLap` signature — add `tuneId` parameter:
```typescript
export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  telemetryPackets: TelemetryPacket[],
  profileId: number | null = null,
  tuneId: number | null = null
): number {
```

Add `tuneId` to the `.values()` call:
```typescript
.values({
  sessionId,
  lapNumber,
  lapTime,
  isValid,
  pi,
  telemetry: compressed,
  profileId,
  tuneId,
})
```

Update `getLaps` select to LEFT JOIN tunes:
```typescript
import { tunes } from "./schema";

export function getLaps(profileId?: number | null): LapMeta[] {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      pi: laps.pi,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id));
  // ... rest unchanged
```

Update `getLapById` to include `tuneId` and `tuneName` via LEFT JOIN:

```typescript
export function getLapById(
  id: number
): (LapMeta & { telemetry: TelemetryPacket[] }) | null {
  const row = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      telemetry: laps.telemetry,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.id, id))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.sessionId,
    lapNumber: row.lapNumber,
    lapTime: row.lapTime,
    isValid: Boolean(row.isValid),
    createdAt: row.createdAt,
    carOrdinal: row.carOrdinal,
    trackOrdinal: row.trackOrdinal,
    tuneId: row.tuneId ?? undefined,
    tuneName: row.tuneName ?? undefined,
    telemetry: decompressTelemetry(row.telemetry as Buffer),
  };
}
```

Add the `tunes` import at the top of `queries.ts`:
```typescript
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, profiles, tunes } from "./schema";
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add server/db/tune-queries.ts server/db/queries.ts test/tune-queries.test.ts
git commit -m "feat: add tune CRUD and assignment DB queries"
```

---

## Task 4: Tune Formatting for AI Prompt

**Files:**
- Create: `server/ai/format-tune.ts`
- Create: `test/format-tune.test.ts`

- [ ] **Step 1: Write failing test for formatTuneForPrompt**

Create `test/format-tune.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { formatTuneForPrompt } from "../server/ai/format-tune";
import type { TuneSettings } from "../shared/types";

const SETTINGS: TuneSettings = {
  tires: { frontPressure: 30.5, rearPressure: 31.0, compound: "Sport" },
  gearing: { finalDrive: 3.42, ratios: [3.29, 2.16, 1.61, 1.27, 1.04, 0.88] },
  alignment: { frontCamber: -1.2, rearCamber: -0.8, frontToe: 0.0, rearToe: 0.1, frontCaster: 5.8 },
  antiRollBars: { front: 22.4, rear: 18.6 },
  springs: { frontRate: 750, rearRate: 680, frontHeight: 5.2, rearHeight: 5.4, unit: "lb/in" },
  damping: { frontRebound: 8.2, rearRebound: 7.4, frontBump: 5.1, rearBump: 4.8 },
  aero: { frontDownforce: 185, rearDownforce: 220, unit: "lb" },
  differential: { rearAccel: 72, rearDecel: 45 },
  brakes: { balance: 54, pressure: 95 },
};

describe("formatTuneForPrompt", () => {
  test("formats complete tune settings", () => {
    const result = formatTuneForPrompt({
      name: "Balanced Circuit v2",
      author: "acoop",
      category: "circuit",
      settings: SETTINGS,
    });
    expect(result).toContain("ACTIVE TUNE");
    expect(result).toContain("Balanced Circuit v2");
    expect(result).toContain("acoop");
    expect(result).toContain("30.5");
    expect(result).toContain("3.42");
    expect(result).toContain("-1.2");
    expect(result).toContain("22.4");
    expect(result).toContain("750");
    expect(result).toContain("8.2");
    expect(result).toContain("185");
    expect(result).toContain("72");
    expect(result).toContain("54");
  });

  test("handles missing optional fields gracefully", () => {
    const minimal: TuneSettings = {
      tires: { frontPressure: 30, rearPressure: 31 },
      gearing: { finalDrive: 3.5 },
      alignment: { frontCamber: -1, rearCamber: -1, frontToe: 0, rearToe: 0 },
      antiRollBars: { front: 20, rear: 20 },
      springs: { frontRate: 700, rearRate: 700, frontHeight: 5, rearHeight: 5 },
      damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
      aero: { frontDownforce: 150, rearDownforce: 200 },
      differential: { rearAccel: 70, rearDecel: 40 },
      brakes: { balance: 50, pressure: 100 },
    };
    const result = formatTuneForPrompt({
      name: "Minimal",
      author: "test",
      category: "circuit",
      settings: minimal,
    });
    expect(result).toContain("Minimal");
    expect(result).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/format-tune.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement format-tune.ts**

Create `server/ai/format-tune.ts`:

```typescript
import type { TuneSettings, TuneCategory } from "../../shared/types";

interface TuneForPrompt {
  name: string;
  author: string;
  category: TuneCategory;
  settings: TuneSettings;
}

export function formatTuneForPrompt(tune: TuneForPrompt): string {
  const s = tune.settings;
  const lines: string[] = [];

  lines.push(`--- ACTIVE TUNE: "${tune.name}" by ${tune.author} (${tune.category}) ---`);

  // Tires
  const compound = s.tires.compound ? ` (${s.tires.compound})` : "";
  lines.push(`Tires: Front ${s.tires.frontPressure} PSI, Rear ${s.tires.rearPressure} PSI${compound}`);

  // Gearing
  const ratios = s.gearing.ratios ? `, Ratios: [${s.gearing.ratios.join(", ")}]` : "";
  lines.push(`Gearing: Final Drive ${s.gearing.finalDrive}${ratios}`);

  // Alignment
  const caster = s.alignment.frontCaster != null ? `, Caster ${s.alignment.frontCaster}°` : "";
  lines.push(`Alignment: Camber F ${s.alignment.frontCamber}° R ${s.alignment.rearCamber}°, Toe F ${s.alignment.frontToe}° R ${s.alignment.rearToe}°${caster}`);

  // Anti-Roll Bars
  lines.push(`Anti-Roll Bars: F ${s.antiRollBars.front}, R ${s.antiRollBars.rear}`);

  // Springs
  const springUnit = s.springs.unit ?? "lb/in";
  lines.push(`Springs: F ${s.springs.frontRate} ${springUnit} @ ${s.springs.frontHeight}in, R ${s.springs.rearRate} ${springUnit} @ ${s.springs.rearHeight}in`);

  // Damping
  lines.push(`Damping: Rebound F ${s.damping.frontRebound} R ${s.damping.rearRebound}, Bump F ${s.damping.frontBump} R ${s.damping.rearBump}`);

  // Aero
  const aeroUnit = s.aero.unit ?? "lb";
  lines.push(`Aero: Front ${s.aero.frontDownforce} ${aeroUnit}, Rear ${s.aero.rearDownforce} ${aeroUnit}`);

  // Differential
  const diff = s.differential;
  let diffStr = `Accel ${diff.rearAccel}%, Decel ${diff.rearDecel}%`;
  if (diff.frontAccel != null) diffStr = `Front Accel ${diff.frontAccel}% Decel ${diff.frontDecel ?? 0}%, Rear ${diffStr}`;
  if (diff.center != null) diffStr += `, Center ${diff.center}%`;
  lines.push(`Differential: ${diffStr}`);

  // Brakes
  lines.push(`Brakes: Balance ${s.brakes.balance}%, Pressure ${s.brakes.pressure}%`);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/format-tune.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/format-tune.ts test/format-tune.test.ts
git commit -m "feat: add tune settings formatter for AI prompt"
```

---

## Task 5: AI Prompt Integration

**Files:**
- Modify: `server/ai/analyst-prompt.ts`

- [ ] **Step 1: Update buildAnalystPrompt to accept optional tune**

Add import and update function signature in `server/ai/analyst-prompt.ts`:

```typescript
import type { Tune } from "../../shared/types";
import { formatTuneForPrompt } from "./format-tune";
```

Add `tune?: Tune` parameter to `buildAnalystPrompt`:

```typescript
export function buildAnalystPrompt(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[],
  corners: CornerDef[],
  units: ExportUnits = { speedUnit: "mph", temperatureUnit: "F" },
  tune?: Tune
): string {
```

- [ ] **Step 2: Inject tune data into prompt context**

After building `cornerData` and `insightsText`, add tune formatting:

```typescript
let tuneText = "";
if (tune) {
  tuneText = "\n" + formatTuneForPrompt({
    name: tune.name,
    author: tune.author,
    category: tune.category,
    settings: tune.settings,
  }) + "\n";
}

const context = `Car: ${carName}
Track: ${trackName}
${tuneText}
${exportText}
${cornerData}
${insightsText}`;
```

- [ ] **Step 3: Update system prompt to reference tune data**

Add to the `RULES:` section in `SYSTEM_PROMPT`:

```
- When tune settings are provided, correlate telemetry symptoms (e.g., understeer, tire temps, suspension bottoming) with specific setup values and recommend concrete adjustments with target numbers
- Reference the actual tune values when suggesting changes (e.g., "Front springs at 750 lb/in are too stiff for this track — try 650-680 lb/in")
```

- [ ] **Step 4: Run existing tests**

Run: `bun test`
Expected: All tests PASS (signature change is backwards-compatible — new param is optional).

- [ ] **Step 5: Commit**

```bash
git add server/ai/analyst-prompt.ts
git commit -m "feat: inject tune settings into AI analysis prompt"
```

---

## Task 6: Lap Detector Tune Snapshot

**Files:**
- Modify: `server/lap-detector.ts`

- [ ] **Step 1: Import getTuneAssignment**

Add to `server/lap-detector.ts` imports:

```typescript
import { getTuneAssignment } from "./db/tune-queries";
```

- [ ] **Step 2: Snapshot tune in onLapComplete**

In the `onLapComplete` method, before the `insertLap` call (around line 241), look up the active tune:

```typescript
// Snapshot active tune assignment for this car+track
const tuneAssignment = getTuneAssignment(
  this.currentSession.carOrdinal,
  this.currentSession.trackOrdinal
);
const tuneId = tuneAssignment?.tuneId ?? null;
```

Then pass `tuneId` to `insertLap`:

```typescript
const lapId = insertLap(
  this.currentSession.sessionId,
  this.currentLapNumber,
  lapTime,
  this.lapIsValid,
  this.lapBuffer,
  activeProfileId,
  tuneId
);
```

- [ ] **Step 3: Snapshot tune in finalizeLapIfNeeded**

Apply the same pattern in `finalizeLapIfNeeded` (around line 283):

```typescript
const tuneAssignment = getTuneAssignment(
  this.currentSession.carOrdinal,
  this.currentSession.trackOrdinal
);
insertLap(
  this.currentSession.sessionId,
  this.currentLapNumber,
  lapTime,
  false,
  this.lapBuffer,
  activeProfileId,
  tuneAssignment?.tuneId ?? null
);
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lap-detector.ts
git commit -m "feat: snapshot active tune assignment when saving laps"
```

---

## Task 7: Tune API Routes

**Files:**
- Create: `server/routes/tune-routes.ts`
- Modify: `server/routes.ts`

- [ ] **Step 1: Create tune-routes.ts with CRUD endpoints**

Create `server/routes/tune-routes.ts`:

```typescript
import { Hono } from "hono";
import {
  insertTune,
  getTunes,
  getTuneById,
  updateTune,
  deleteTune,
  setTuneAssignment,
  getTuneAssignment,
  getTuneAssignments,
  deleteTuneAssignment,
  updateLapTune,
} from "../db/tune-queries";
import { TUNE_CATALOG } from "../../client/src/data/tune-catalog";

export const tuneRoutes = new Hono();

// --- Tune CRUD ---

tuneRoutes.get("/api/tunes", (c) => {
  const carOrdinal = c.req.query("carOrdinal");
  const tunes = getTunes(carOrdinal ? parseInt(carOrdinal, 10) : undefined);
  return c.json(
    tunes.map((t) => ({
      ...t,
      strengths: t.strengths ? JSON.parse(t.strengths) : [],
      weaknesses: t.weaknesses ? JSON.parse(t.weaknesses) : [],
      bestTracks: t.bestTracks ? JSON.parse(t.bestTracks) : [],
      strategies: t.strategies ? JSON.parse(t.strategies) : [],
      settings: JSON.parse(t.settings),
    }))
  );
});

tuneRoutes.get("/api/tunes/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);
  const tune = getTuneById(id);
  if (!tune) return c.json({ error: "Tune not found" }, 404);
  return c.json({
    ...tune,
    strengths: tune.strengths ? JSON.parse(tune.strengths) : [],
    weaknesses: tune.weaknesses ? JSON.parse(tune.weaknesses) : [],
    bestTracks: tune.bestTracks ? JSON.parse(tune.bestTracks) : [],
    strategies: tune.strategies ? JSON.parse(tune.strategies) : [],
    settings: JSON.parse(tune.settings),
  });
});

tuneRoutes.post("/api/tunes", async (c) => {
  const body = await c.req.json();
  const { name, author, carOrdinal, category, trackOrdinal, description, strengths, weaknesses, bestTracks, strategies, settings } = body;
  if (!name || !author || carOrdinal == null || !category || !settings) {
    return c.json({ error: "Missing required fields: name, author, carOrdinal, category, settings" }, 400);
  }
  if (!validateTuneSettings(settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }
  const id = insertTune({
    name,
    author,
    carOrdinal,
    category,
    trackOrdinal,
    description: description ?? "",
    strengths: strengths ? JSON.stringify(strengths) : undefined,
    weaknesses: weaknesses ? JSON.stringify(weaknesses) : undefined,
    bestTracks: bestTracks ? JSON.stringify(bestTracks) : undefined,
    strategies: strategies ? JSON.stringify(strategies) : undefined,
    settings: JSON.stringify(settings),
  });
  return c.json({ id }, 201);
});

tuneRoutes.put("/api/tunes/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);
  const body = await c.req.json();
  if (body.settings && !validateTuneSettings(body.settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }
  const data: Record<string, any> = {};
  for (const key of ["name", "author", "carOrdinal", "category", "trackOrdinal", "description"]) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  for (const key of ["strengths", "weaknesses", "bestTracks", "strategies", "settings"]) {
    if (body[key] !== undefined) data[key] = JSON.stringify(body[key]);
  }
  const updated = updateTune(id, data);
  if (!updated) return c.json({ error: "Tune not found" }, 404);
  return c.json({ ok: true });
});

tuneRoutes.delete("/api/tunes/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);
  const deleted = deleteTune(id);
  if (!deleted) return c.json({ error: "Tune not found" }, 404);
  return c.json({ ok: true });
});

// --- Import (JSON paste) ---

tuneRoutes.post("/api/tunes/import", async (c) => {
  const body = await c.req.json();
  const { name, author, carOrdinal, category, settings, ...rest } = body;
  if (!name || !author || carOrdinal == null || !category || !settings) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  if (!validateTuneSettings(settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }
  const id = insertTune({
    name,
    author,
    carOrdinal,
    category,
    trackOrdinal: rest.trackOrdinal,
    description: rest.description ?? "",
    strengths: rest.strengths ? JSON.stringify(rest.strengths) : undefined,
    weaknesses: rest.weaknesses ? JSON.stringify(rest.weaknesses) : undefined,
    bestTracks: rest.bestTracks ? JSON.stringify(rest.bestTracks) : undefined,
    strategies: rest.strategies ? JSON.stringify(rest.strategies) : undefined,
    settings: JSON.stringify(settings),
    source: "user",
  });
  return c.json({ id }, 201);
});

// --- Clone catalog tune ---

tuneRoutes.post("/api/tunes/clone/:catalogId", (c) => {
  const catalogId = c.req.param("catalogId");
  const catalogTune = TUNE_CATALOG.find((t) => t.id === catalogId);
  if (!catalogTune) return c.json({ error: "Catalog tune not found" }, 404);

  const id = insertTune({
    name: `${catalogTune.name} (copy)`,
    author: catalogTune.author,
    carOrdinal: catalogTune.carOrdinal,
    category: catalogTune.category,
    trackOrdinal: catalogTune.trackOrdinal,
    description: catalogTune.description,
    strengths: JSON.stringify(catalogTune.strengths),
    weaknesses: JSON.stringify(catalogTune.weaknesses),
    bestTracks: catalogTune.bestTracks ? JSON.stringify(catalogTune.bestTracks) : undefined,
    strategies: catalogTune.strategies ? JSON.stringify(catalogTune.strategies) : undefined,
    settings: JSON.stringify(catalogTune.settings),
    source: "catalog-clone",
    catalogId,
  });
  return c.json({ id }, 201);
});

// --- Catalog (read-only) ---

tuneRoutes.get("/api/catalog/tunes", (c) => {
  const carOrdinal = c.req.query("carOrdinal");
  let result = TUNE_CATALOG;
  if (carOrdinal) {
    result = result.filter((t) => t.carOrdinal === parseInt(carOrdinal, 10));
  }
  return c.json(result);
});

// --- Tune Assignments ---

tuneRoutes.get("/api/tune-assignments", (c) => {
  const carOrdinal = c.req.query("carOrdinal");
  return c.json(getTuneAssignments(carOrdinal ? parseInt(carOrdinal, 10) : undefined));
});

tuneRoutes.get("/api/tune-assignments/:carOrdinal/:trackOrdinal", (c) => {
  const carOrdinal = parseInt(c.req.param("carOrdinal"), 10);
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(carOrdinal) || isNaN(trackOrdinal)) return c.json({ error: "Invalid params" }, 400);
  const assignment = getTuneAssignment(carOrdinal, trackOrdinal);
  if (!assignment) return c.json({ error: "No assignment" }, 404);
  return c.json(assignment);
});

tuneRoutes.put("/api/tune-assignments", async (c) => {
  const { carOrdinal, trackOrdinal, tuneId } = await c.req.json();
  if (carOrdinal == null || trackOrdinal == null || tuneId == null) {
    return c.json({ error: "Missing carOrdinal, trackOrdinal, or tuneId" }, 400);
  }
  setTuneAssignment(carOrdinal, trackOrdinal, tuneId);
  return c.json({ ok: true });
});

tuneRoutes.delete("/api/tune-assignments/:carOrdinal/:trackOrdinal", (c) => {
  const carOrdinal = parseInt(c.req.param("carOrdinal"), 10);
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(carOrdinal) || isNaN(trackOrdinal)) return c.json({ error: "Invalid params" }, 400);
  const deleted = deleteTuneAssignment(carOrdinal, trackOrdinal);
  if (!deleted) return c.json({ error: "No assignment found" }, 404);
  return c.json({ ok: true });
});

// --- Lap Tune Override ---

tuneRoutes.patch("/api/laps/:id/tune", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);
  const { tuneId } = await c.req.json();
  const updated = updateLapTune(id, tuneId ?? null);
  if (!updated) return c.json({ error: "Lap not found" }, 404);
  return c.json({ ok: true });
});

// --- Validation ---

function validateTuneSettings(settings: any): boolean {
  if (!settings || typeof settings !== "object") return false;
  const required = ["tires", "gearing", "alignment", "antiRollBars", "springs", "damping", "aero", "differential", "brakes"];
  for (const key of required) {
    if (!settings[key] || typeof settings[key] !== "object") return false;
  }
  // Check nested required fields
  if (typeof settings.tires.frontPressure !== "number" || typeof settings.tires.rearPressure !== "number") return false;
  if (typeof settings.gearing.finalDrive !== "number") return false;
  if (typeof settings.brakes.balance !== "number" || typeof settings.brakes.pressure !== "number") return false;
  return true;
}
```

- [ ] **Step 2: Create routes directory**

Run: `mkdir -p server/routes`

- [ ] **Step 3: Mount tune routes in main routes.ts**

In `server/routes.ts`, add import and mount near the top after existing imports:

```typescript
import { tuneRoutes } from "./routes/tune-routes";
```

After `const app = new Hono();` and the cors middleware setup, add:

```typescript
app.route("/", tuneRoutes);
```

- [ ] **Step 4: Update analyse route to pass tune to prompt builder**

In `server/routes.ts`, in the `POST /api/laps/:id/analyse` handler, after `const lap = getLapById(id)`, add tune lookup:

```typescript
import { getTuneById as getTuneByIdFromDb } from "./db/tune-queries";
```

Then in the route handler:

```typescript
// Look up tune for this lap (if assigned)
const tune = lap.tuneId ? getTuneByIdFromDb(lap.tuneId) : null;
const parsedTune = tune ? {
  ...tune,
  strengths: tune.strengths ? JSON.parse(tune.strengths) : [],
  weaknesses: tune.weaknesses ? JSON.parse(tune.weaknesses) : [],
  bestTracks: tune.bestTracks ? JSON.parse(tune.bestTracks) : [],
  strategies: tune.strategies ? JSON.parse(tune.strategies) : [],
  settings: JSON.parse(tune.settings),
} as Tune : undefined;

// Build prompt (pass tune)
const prompt = buildAnalystPrompt(lap, lap.telemetry, corners, units, parsedTune);
```

- [ ] **Step 5: Run server to verify routes work**

Run: `bun run dev:server`
Test: `curl http://localhost:3117/api/tunes` should return `[]`.
Test: `curl http://localhost:3117/api/catalog/tunes` should return the 7 catalog tunes.

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/tune-routes.ts server/routes.ts
git commit -m "feat: add tune CRUD, assignment, and catalog API routes"
```

---

## Task 8: Client — Tune Manager UI

**Files:**
- Modify: `client/src/components/TuneCatalog.tsx`
- Modify: `client/src/routes/tunes.tsx`

This task extends the existing `TuneCatalog` component with:
1. Fetching user tunes from the API alongside static catalog tunes
2. Create/edit tune form with collapsible `TuneSettings` sections
3. JSON import textarea
4. Clone catalog tune button
5. Delete user tune
6. Tune assignment dropdown per car+track

- [ ] **Step 1: Add TanStack Query hooks for tune API**

Add to `TuneCatalog.tsx` (or a new `client/src/lib/tune-api.ts` if the file gets large):

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

function useTunes(carOrdinal?: number) {
  return useQuery({
    queryKey: ["tunes", carOrdinal],
    queryFn: () => fetch(`/api/tunes${carOrdinal ? `?carOrdinal=${carOrdinal}` : ""}`).then(r => r.json()),
  });
}

function useCatalogTunes(carOrdinal?: number) {
  return useQuery({
    queryKey: ["catalog-tunes", carOrdinal],
    queryFn: () => fetch(`/api/catalog/tunes${carOrdinal ? `?carOrdinal=${carOrdinal}` : ""}`).then(r => r.json()),
  });
}

function useCreateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetch("/api/tunes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunes"] }),
  });
}

function useCloneTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (catalogId: string) => fetch(`/api/tunes/clone/${catalogId}`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunes"] }),
  });
}

function useDeleteTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => fetch(`/api/tunes/${id}`, { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunes"] }),
  });
}

function useTuneAssignments(carOrdinal?: number) {
  return useQuery({
    queryKey: ["tune-assignments", carOrdinal],
    queryFn: () => fetch(`/api/tune-assignments${carOrdinal ? `?carOrdinal=${carOrdinal}` : ""}`).then(r => r.json()),
  });
}

function useSetTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { carOrdinal: number; trackOrdinal: number; tuneId: number }) =>
      fetch("/api/tune-assignments", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tune-assignments"] }),
  });
}
```

- [ ] **Step 2: Build TuneSettingsForm component**

Create a form component with collapsible sections for each `TuneSettings` group. Each section has labeled number inputs. Use shadcn `Collapsible`, `Input`, `Label`, `Button` components. The form state is a `TuneSettings` object.

Sections: Tires, Gearing, Alignment, Anti-Roll Bars, Springs, Damping, Aero, Differential, Brakes.

Include a "JSON Import" toggle that shows a textarea. On paste + click "Parse", validate and populate the form.

- [ ] **Step 3: Extend TuneCatalog to show user tunes + catalog tunes**

The component should:
- Fetch both `useTunes()` and `useCatalogTunes()`
- Render two sections: "My Tunes" (user-created, with edit/delete) and "Catalog" (read-only, with "Clone" button)
- "New Tune" button opens the create form
- Car filter dropdown at the top

- [ ] **Step 4: Add tune assignment UI**

For each car+track combo that has tunes, show a dropdown to select the active/default tune. Use `useSetTuneAssignment` mutation.

- [ ] **Step 5: Verify in browser**

Run: `bun run dev`
Navigate to `/tunes` route. Verify:
- Catalog tunes display
- Can clone a catalog tune
- Can create a new tune via form
- Can create via JSON import
- Can delete user tunes
- Can set tune assignments

- [ ] **Step 6: Commit**

```bash
git add client/src/components/TuneCatalog.tsx client/src/routes/tunes.tsx
git commit -m "feat: extend TuneCatalog with user tune CRUD, clone, and assignment UI"
```

---

## Task 9: Client — Per-Lap Tune Override

**Files:**
- Modify: `client/src/components/LapAnalyse.tsx`

- [ ] **Step 1: Add tune dropdown to lap detail view**

In `LapAnalyse.tsx`, add a tune selector that:
- Fetches available tunes for the lap's `carOrdinal` via `useTunes(carOrdinal)`
- Shows current tune assignment (from `lap.tuneName`) or "No tune"
- Shows "(default)" label when the tune was auto-assigned vs manually overridden
- Dropdown to change tune — calls `PATCH /api/laps/:id/tune`
- "Clear" option to set `tuneId` to null

```typescript
function useUpdateLapTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lapId, tuneId }: { lapId: number; tuneId: number | null }) =>
      fetch(`/api/laps/${lapId}/tune`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tuneId }),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["laps"] }),
  });
}
```

- [ ] **Step 2: Show tune badge in lap list**

In the lap list rendering (wherever laps are mapped), show a small badge with `lap.tuneName` if present.

- [ ] **Step 3: Verify in browser**

Run: `bun run dev`
Navigate to a lap detail. Verify tune dropdown works, per-lap override saves, and tune badge shows in lap list.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/LapAnalyse.tsx
git commit -m "feat: add per-lap tune override dropdown and tune badges"
```

---

## Task 10: Schema Push & End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Push schema changes**

Run: `bun run db:push`
Expected: Tables created/updated successfully.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 3: Run client build**

Run: `cd client && bun run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: End-to-end smoke test**

Run: `bun run dev`

1. Go to `/tunes` — verify catalog tunes display
2. Clone a catalog tune — verify it appears in "My Tunes"
3. Create a new tune via form — fill all fields, save
4. Create a tune via JSON import — paste valid JSON, save
5. Set a tune assignment for a car+track
6. If telemetry is running, verify new laps get the `tuneId` snapshotted
7. Open a lap with a tune, run AI analysis — verify tune settings appear in the analysis context
8. Override a lap's tune — verify it persists

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: tune assignment end-to-end fixes"
```
