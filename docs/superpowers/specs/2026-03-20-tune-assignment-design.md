# Tune Assignment & AI Integration — Design Spec

## Summary

Add the ability for users to create, import, and manage car tunes, assign them to car+track combinations as defaults, snapshot the active tune onto each lap at recording time, allow per-lap overrides, and pass full structured tune settings to the AI analysis prompt.

## Requirements

- **Tune entry**: Manual form (full fidelity — all `TuneSettings` fields) + JSON import
- **Assignment model**: Default tune per `(carOrdinal, trackOrdinal)` with per-lap override
- **Point-in-time**: Laps snapshot the active tune at recording time; old laps keep their original assignment
- **AI integration**: Full structured settings passed to Claude in the analysis prompt
- **Catalog coexistence**: Static catalog tunes (`shared/tunes/`) remain read-only; users can clone them into the DB to make editable copies

## Data Model

### New `tunes` table

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTO | |
| name | TEXT NOT NULL | |
| author | TEXT NOT NULL | |
| carOrdinal | INTEGER NOT NULL | |
| category | TEXT NOT NULL | `'circuit' \| 'wet' \| 'low-drag' \| 'stable' \| 'track-specific'` |
| trackOrdinal | INTEGER | NULL for general tunes |
| description | TEXT NOT NULL DEFAULT '' | |
| strengths | TEXT | JSON array of strings |
| weaknesses | TEXT | JSON array of strings |
| bestTracks | TEXT | JSON array of strings (preserved on catalog clone) |
| strategies | TEXT | JSON array of `RaceStrategy` objects (preserved on catalog clone) |
| settings | TEXT NOT NULL | JSON blob matching `TuneSettings` interface |
| source | TEXT NOT NULL DEFAULT 'user' | `'user' \| 'catalog-clone'` |
| catalogId | TEXT | Original catalog tune ID if cloned |
| createdAt | TEXT | `datetime('now')` |
| updatedAt | TEXT | `datetime('now')` |

Indexes: `(carOrdinal)` for filtering tunes by car.

All JSON text columns (`strengths`, `weaknesses`, `bestTracks`, `strategies`, `settings`) are stored as JSON strings in SQLite. The API layer parses on read and stringifies on write.

### New `tuneAssignments` table

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTO | |
| carOrdinal | INTEGER NOT NULL | |
| trackOrdinal | INTEGER NOT NULL | |
| tuneId | INTEGER NOT NULL | FK → `tunes(id)` ON DELETE CASCADE |

Unique constraint: `(carOrdinal, trackOrdinal)` — one active tune per combo.
Index: `(tuneId)` for efficient CASCADE deletes.

### Modified `laps` table

New nullable column:

| Column | Type | Notes |
|--------|------|-------|
| tuneId | INTEGER | FK → `tunes(id)` ON DELETE SET NULL. Drizzle: `tuneId: integer("tune_id")` |

## API Endpoints

### Tune CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tunes` | List user tunes. Optional `?carOrdinal=` filter |
| GET | `/api/tunes/:id` | Get single tune |
| POST | `/api/tunes` | Create tune (full settings JSON body). Validates `settings` against `TuneSettings` schema. |
| PUT | `/api/tunes/:id` | Update tune. Validates `settings` against `TuneSettings` schema. |
| DELETE | `/api/tunes/:id` | Delete tune (cascades assignments, laps get `tuneId = NULL`) |
| POST | `/api/tunes/import` | Create tune from pasted JSON (validates against `TuneSettings`) |
| POST | `/api/tunes/clone/:catalogId` | Clone static catalog tune into DB as user tune |

### Tune Assignments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tune-assignments` | List all assignments. Optional `?carOrdinal=` filter. Joins tune name for display. |
| GET | `/api/tune-assignments/:carOrdinal/:trackOrdinal` | Get the specific assignment for a car+track pair (or 404) |
| PUT | `/api/tune-assignments` | Set/update default tune for car+track. Body: `{ carOrdinal, trackOrdinal, tuneId }` |
| DELETE | `/api/tune-assignments/:carOrdinal/:trackOrdinal` | Remove default assignment |

### Lap Tune Override

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/api/laps/:id/tune` | Set or clear tune for a specific lap. Body: `{ tuneId: number \| null }` |

### Catalog (read-only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/catalog/tunes` | Return static catalog tunes. Optional `?carOrdinal=` filter |

## Lap Detector Integration

In `LapDetector.onLapComplete()` and `finalizeLapIfNeeded()`:

1. After determining `carOrdinal` and `trackOrdinal` from the current session, query `tuneAssignments` for a matching row
2. If found, pass the `tuneId` to `insertLap()`
3. `insertLap()` gains a new optional `tuneId` parameter. Updated signature:
   ```typescript
   insertLap(sessionId, lapNumber, lapTime, isValid, telemetryPackets, profileId?, tuneId?)
   ```

The lookup uses the unique index on `(carOrdinal, trackOrdinal)` — negligible overhead at 60 Hz packet rate (query runs once per lap, not per packet).

## AI Analysis Integration

In `buildAnalystPrompt()`, after the `Car:` / `Track:` header, inject a tune section when the lap has a `tuneId`:

1. The caller (`/api/laps/:id/analyse` route) looks up the tune from the `tunes` table by `tuneId` and passes the full `Tune` object to `buildAnalystPrompt()`. The prompt builder receives an optional `tune?: Tune` parameter — it does not perform DB lookups itself. If `tuneId` is set but the tune has been deleted (SET NULL), no tune section is injected.
2. Format all structured settings into a human-readable block:

```
--- ACTIVE TUNE: "Balanced Circuit v2" by acoop (circuit) ---
Tires: Front 30.5 PSI, Rear 31.0 PSI
Gearing: Final Drive 3.42, Ratios: [3.29, 2.16, 1.61, ...]
Alignment: Camber F -1.2° R -0.8°, Toe F 0.0° R 0.1°, Caster 5.8°
Anti-Roll Bars: F 22.4, R 18.6
Springs: F 750 lb/in @ 5.2in, R 680 lb/in @ 5.4in
Damping: Rebound F 8.2 R 7.4, Bump F 5.1 R 4.8
Aero: Front 185 lb, Rear 220 lb
Differential: Accel 72%, Decel 45%
Brakes: Balance 54%, Pressure 95%
```

3. Update the system prompt to tell the AI: "When tune settings are provided, correlate telemetry symptoms with specific setup values and recommend concrete adjustments with target numbers."

## UI Changes

### Tune Manager (new component)

- Accessible from a new "Tunes" section or modal
- List view: shows user tunes + catalog tunes (visually differentiated). Filter by car.
- Catalog tunes have a "Clone to My Tunes" button
- Create/edit form: collapsible sections matching `TuneSettings` groups — Tires, Gearing, Alignment, Anti-Roll Bars, Springs, Damping, Aero, Differential, Brakes
- JSON import: textarea + parse button, validates against `TuneSettings` schema
- Each tune shows metadata (name, author, category, car, track, strengths, weaknesses)

### Tune Assignment (in lap list / session view)

- Dropdown to set/change the default tune for the current car+track combination
- Shows the currently assigned tune name
- "Clear" option to remove the assignment

### Per-Lap Override (in LapAnalyse.tsx)

- Dropdown on the lap detail view to change or clear the tune for that specific lap
- Shows "(default)" label when using the car+track assignment vs explicit override

### Visual Indicators

- Lap list shows a small tune name badge next to laps that have a tune assigned
- Different styling for default-assigned vs explicitly-overridden tunes

## Shared Types

Move `TuneSettings` interface from `client/src/data/tune-catalog.ts` to `shared/types.ts` so both server and client can use it. Add new shared types:

```typescript
export interface Tune {
  id: number;
  name: string;
  author: string;
  carOrdinal: number;
  category: 'circuit' | 'wet' | 'low-drag' | 'stable' | 'track-specific';
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
  tuneName?: string; // joined for display
}
```

Update `LapMeta` to include optional `tuneId` and `tuneName`.

### Query Changes

- `getLaps()` and `getLapById()` must LEFT JOIN the `tunes` table on `laps.tuneId = tunes.id` to select `tunes.name as tuneName`. This avoids N+1 queries when rendering tune badges in the lap list.
- All write paths (`POST /api/tunes`, `PUT /api/tunes/:id`, `POST /api/tunes/import`) validate the `settings` field using a shared validation function.

### Known Limitation

Editing a tune after laps have been recorded with that `tuneId` changes the historical context. This is acceptable — tunes evolve, and the AI should always see the current tune state. Users who want to preserve a historical snapshot can clone the tune before editing.

## Migration Strategy

- Add `tunes` and `tuneAssignments` tables via Drizzle schema + `bun run db:push`
- Add `tuneId` column to `laps` table (nullable, no migration needed for existing rows — they'll have NULL)
- Existing laps with no tune remain unaffected
- Users can retroactively assign tunes to old laps via the per-lap override UI
