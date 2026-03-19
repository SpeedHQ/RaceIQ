# AI Analyst for Lap Analysis

**Date:** 2026-03-19
**Status:** Approved

## Overview

Add an AI analyst capability to the Analyse page that sends lap telemetry to Claude CLI and displays structured driving/tuning analysis in a modal dialog. Results are persisted to avoid redundant API calls.

## User Flow

1. User opens a lap in the Analyse page
2. Clicks "AI Analysis" button in the toolbar area
3. Server checks DB for cached analysis for this lap
4. If cached → return immediately
5. If not → build enriched prompt with telemetry + corner data, spawn `claude -p`, wait for response
6. Save response to DB, return to client
7. Client renders markdown in a modal dialog
8. User can click "Regenerate" to force a fresh analysis

## Architecture

```
[Analyse UI] → "AI Analysis" button
    ↓
POST /api/laps/:id/analyse
    ↓
Server checks `lapAnalyses` table → cached? return it
    ↓ (cache miss)
Builds prompt: enriched telemetry export + corner data + car/track names
    ↓
Pipes prompt to `claude -p -` via stdin (Bun.spawn), waits for stdout
    ↓
Saves response to DB, returns { analysis, cached }
    ↓
Client renders markdown in modal + "Regenerate" button
```

## Components

### 1. Database: `lapAnalyses` table

New table added in two places (matching existing codebase pattern):

**Raw SQL in `server/db/index.ts`** (appended to existing `CREATE TABLE` block):

```sql
CREATE TABLE IF NOT EXISTS lap_analyses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lap_id      INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
  analysis    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Drizzle schema in `server/db/schema.ts`:**

```typescript
export const lapAnalyses = sqliteTable("lap_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lapId: integer("lap_id").notNull().references(() => laps.id, { onDelete: "cascade" }),
  analysis: text("analysis").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (table) => [
  unique().on(table.lapId),
]);
```

- One cached analysis per lap (unique on `lapId`)
- Cascade delete when lap is deleted
- Regenerate replaces existing row

### 2. Server Endpoint

**`POST /api/laps/:id/analyse`**

Query params:
- `regenerate=true` — skip cache, force fresh analysis

Response:
```json
{
  "analysis": "## Performance Summary\n...",
  "cached": true
}
```

Flow:
1. Validate lap ID, fetch lap data
2. If not `regenerate`, check `lapAnalyses` table → return if found
3. Build prompt context:
   - Reuse `generateExport()` for telemetry summary (extract from `routes.ts` to `server/export.ts` — currently a local function)
   - Enrich with car name (`getCarName()`) and track name (`getTrackName()`)
   - Add corner-level data: per-corner min speed, braking point, exit speed, gear, time spent
   - Add track segment data if available
4. Pipe prompt to `claude` via stdin using `Bun.spawn`:
   ```typescript
   const proc = Bun.spawn(["claude", "-p", "-"], { stdin: "pipe" });
   proc.stdin.write(prompt);
   proc.stdin.end();
   const output = await new Response(proc.stdout).text();
   ```
   This avoids OS argument length limits with large telemetry payloads.
5. Capture stdout, save to DB (upsert — replace if regenerating)
6. Return response

Concurrency: The client disables the "Regenerate" button while a request is in-flight to prevent duplicate subprocess spawns for the same lap.

Error handling:
- `claude` not found → 500 with clear error message
- Process timeout (90s) → kill and return 504 (no partial DB state to clean up — save only happens on success)
- Empty response → 500

### 3. Prompt Template (`server/ai/analyst-prompt.ts`)

System prompt defines:
- **Persona:** Expert Forza Motorsport racing engineer and driving coach
- **Output structure:** Fixed markdown template with sections:
  1. **Performance Summary** — overall lap assessment in 2-3 sentences
  2. **Strengths** — what the driver did well (3-5 bullet points with data references)
  3. **Weaknesses** — areas for improvement (3-5 bullet points with data references)
  4. **Problem Corners** — top 3-5 corners where time is being lost, with specific advice per corner (braking point, line, gear, exit)
  5. **Driving Technique** — actionable driving advice (trail braking, throttle modulation, etc.)
  6. **Tuning Recommendations** — specific tuning changes based on telemetry patterns (suspension, aero, gearing, differential, tire pressure)
- **Constraints:**
  - Reference specific telemetry values from the data
  - Be specific and actionable, not generic
  - Keep total output under 800 words
  - Use markdown formatting with headers and bullet points

Context payload includes:
- Car name, class, PI, drivetrain
- Track name
- Full telemetry export (from `generateExport()`)
- Corner-level breakdown (computed from telemetry + corner/segment definitions)

### 4. Corner-Level Data Builder (`server/ai/corner-data.ts`)

Extracts per-corner metrics from telemetry packets using existing corner/segment definitions:

For each corner:
- Entry speed (speed at corner start)
- Minimum speed (lowest speed in corner)
- Exit speed (speed at corner end)
- Braking point (distance before corner where brake > 20%)
- Gear used (most common gear in corner)
- Time spent in corner
- Throttle application point (where throttle > 50% in corner)
- Any oversteer/understeer indicators (tire slip ratios)

This data is formatted as a text table appended to the prompt context.

### 5. Client: `AiAnalysisModal` Component

**File:** `client/src/components/AiAnalysisModal.tsx`

Props:
- `lapId: number`
- `open: boolean`
- `onClose: () => void`
- `carName: string`
- `trackName: string`

States:
- `idle` — modal closed
- `loading` — waiting for server response (show spinner + "Analysing lap...")
- `complete` — show rendered markdown
- `error` — show error message with retry button

UI:
- Custom modal built with existing Base-UI + Tailwind patterns (matching `client/src/components/ui/` style)
- Dark theme consistent with app
- Header: "AI Analysis — {carName} at {trackName}"
- Body: rendered markdown (using `react-markdown`)
- Footer: "Regenerate" button + "Close" button
- Loading state: centered spinner with text

### 6. Integration into LapAnalyse

Add to the toolbar/controls area in `LapAnalyse.tsx`:
- "AI Analysis" button (sparkle icon from lucide-react)
- `useState` for modal open state
- Only enabled when a lap is selected and loaded

### 7. New Dependency

- `react-markdown` — for rendering the Claude response as formatted markdown in the modal

## Data Flow Summary

```
LapAnalyse (button click)
  → POST /api/laps/:id/analyse
    → Check lapAnalyses table
    → [cache miss] generateExport() + getCarName() + getTrackName() + buildCornerData()
    → Bun.spawn(["claude", "-p", "-"], stdin: prompt)
    → Save to lapAnalyses table
    → Return { analysis, cached }
  → AiAnalysisModal renders markdown
```

## File Changes

| File | Change |
|------|--------|
| `server/db/schema.ts` | Add `lapAnalyses` table |
| `server/db/queries.ts` | Add `getAnalysis()`, `saveAnalysis()` query functions |
| `server/ai/analyst-prompt.ts` | New — prompt template and builder |
| `server/ai/corner-data.ts` | New — corner-level telemetry extraction |
| `server/export.ts` | New — extract `generateExport()` + `findBrakingZones()` from `routes.ts` |
| `server/routes.ts` | Add `POST /api/laps/:id/analyse` endpoint, import `generateExport` from `export.ts` |
| `server/db/index.ts` | Add `CREATE TABLE IF NOT EXISTS lap_analyses` SQL |
| `client/src/components/AiAnalysisModal.tsx` | New — modal component |
| `client/src/components/LapAnalyse.tsx` | Add AI Analysis button + modal state |
| `client/package.json` | Add `react-markdown` dependency |

## Non-Goals

- No streaming — full request/response for clean markdown rendering
- No comparison analysis (two-lap) — single lap only for now
- No prompt customization in the UI
- No analysis history/versioning — one cached result per lap, regenerate replaces

## Known Limitations

- If corner definitions for a track are updated after an analysis was cached, the cached analysis won't reflect the new corners. User can click "Regenerate" to get fresh analysis with updated corners.
