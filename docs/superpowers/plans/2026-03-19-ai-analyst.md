# AI Analyst Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI analyst button to the Analyse page that sends lap telemetry to Claude CLI and displays structured driving/tuning analysis in a cached modal dialog.

**Architecture:** Server-side endpoint spawns `claude -p -` via `Bun.spawn`, piping an enriched telemetry prompt via stdin. Results are cached in a `lap_analyses` SQLite table. Client renders the markdown response in a modal with a Regenerate button.

**Tech Stack:** Bun, Hono, Drizzle ORM, SQLite, React 19, Base-UI, Tailwind CSS, react-markdown, lucide-react

**Spec:** `docs/superpowers/specs/2026-03-19-ai-analyst-design.md`

---

### Task 1: Database — Add `lap_analyses` table

**Files:**
- Modify: `server/db/index.ts` (add raw SQL CREATE TABLE after line 62)
- Modify: `server/db/schema.ts` (add Drizzle schema definition)
- Modify: `server/db/queries.ts` (add query functions)

- [ ] **Step 1: Add raw SQL table creation in `server/db/index.ts`**

Append inside the existing `sqlite.exec(...)` template literal, before the closing backtick on line 66:

```sql
  CREATE TABLE IF NOT EXISTS lap_analyses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lap_id      INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
    analysis    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Add Drizzle schema in `server/db/schema.ts`**

Add at end of file:

```typescript
export const lapAnalyses = sqliteTable("lap_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lapId: integer("lap_id")
    .notNull()
    .references(() => laps.id, { onDelete: "cascade" }),
  analysis: text("analysis").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (table) => [
  unique().on(table.lapId),
]);
```

- [ ] **Step 3: Add query functions in `server/db/queries.ts`**

Add import of `lapAnalyses` from schema, then add two functions:

```typescript
// At top: add lapAnalyses to the import from "./schema"

/**
 * Get cached AI analysis for a lap. Returns the analysis text or null.
 */
export function getAnalysis(lapId: number): string | null {
  const row = db
    .select({ analysis: lapAnalyses.analysis })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();
  return row?.analysis ?? null;
}

/**
 * Save or replace AI analysis for a lap.
 */
export function saveAnalysis(lapId: number, analysis: string): void {
  const existing = db
    .select({ id: lapAnalyses.id })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();

  if (existing) {
    db.update(lapAnalyses)
      .set({ analysis, createdAt: sql`(datetime('now'))` })
      .where(eq(lapAnalyses.lapId, lapId))
      .run();
  } else {
    db.insert(lapAnalyses)
      .values({ lapId, analysis })
      .run();
  }
}
```

- [ ] **Step 4: Verify server starts without errors**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun run server/index.ts`
Expected: Server starts on port 3117 without errors. Kill it after confirming.

- [ ] **Step 5: Commit**

```bash
git add server/db/index.ts server/db/schema.ts server/db/queries.ts
git commit -m "feat: add lap_analyses table for AI analysis caching"
```

---

### Task 2: Extract `generateExport` to shared module

**Files:**
- Create: `server/export.ts`
- Modify: `server/routes.ts` (remove local function, import from new module)

- [ ] **Step 1: Create `server/export.ts`**

Extract the `generateExport()` function (lines 847-972) and `findBrakingZones()` function (lines 980-1021) from `server/routes.ts` into a new file `server/export.ts`.

The file should:
- Import `TelemetryPacket`, `CAR_CLASS_NAMES`, `DRIVETRAIN_NAMES` from `../shared/types`
- Export both `generateExport` and `findBrakingZones`
- Keep the exact same function signatures and logic

```typescript
import {
  CAR_CLASS_NAMES,
  DRIVETRAIN_NAMES,
  type TelemetryPacket,
} from "../shared/types";

interface BrakingZone {
  startSpeed: number;
  endSpeed: number;
  distance: number;
}

export function findBrakingZones(
  packets: TelemetryPacket[],
  speeds: number[]
): BrakingZone[] {
  // ... exact same code from routes.ts lines 984-1021
}

export function generateExport(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[]
): string {
  // ... exact same code from routes.ts lines 847-972
  // Update to call the local findBrakingZones
}
```

- [ ] **Step 2: Update `server/routes.ts` to import from `server/export.ts`**

- Add `import { generateExport } from "./export";` at the top of routes.ts
- Delete the local `generateExport()` function (lines 847-972)
- Delete the local `BrakingZone` interface (lines 974-978)
- Delete the local `findBrakingZones()` function (lines 980-1021)

- [ ] **Step 3: Verify the export endpoint still works**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun run server/index.ts`
Expected: Server starts without errors. If you have lap data, test `curl http://localhost:3117/api/laps` to confirm routes work.

- [ ] **Step 4: Commit**

```bash
git add server/export.ts server/routes.ts
git commit -m "refactor: extract generateExport to shared module"
```

---

### Task 3: Build prompt template and corner data builder

**Files:**
- Create: `server/ai/analyst-prompt.ts`
- Create: `server/ai/corner-data.ts`

- [ ] **Step 1: Create `server/ai/corner-data.ts`**

This module extracts per-corner metrics from telemetry packets. It uses the `DistanceTraveled` field to map packets to corners.

```typescript
import type { TelemetryPacket } from "../../shared/types";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

interface CornerMetrics {
  label: string;
  entrySpeed: number;   // mph
  minSpeed: number;     // mph
  exitSpeed: number;    // mph
  gear: number;         // most common gear
  brakingDistance: number; // meters before corner start where braking began
  timeInCorner: number; // seconds
  avgThrottle: number;  // 0-100%
  avgBrake: number;     // 0-100%
  throttleOnDist: number; // meters into corner where throttle > 50%
  balance: "oversteer" | "understeer" | "neutral";
}

function packetSpeed(p: TelemetryPacket): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.237;
}

export function buildCornerData(
  packets: TelemetryPacket[],
  corners: CornerDef[]
): string {
  if (corners.length === 0 || packets.length === 0) return "";

  const metrics: CornerMetrics[] = [];

  for (const corner of corners) {
    // Find packets within this corner's distance range
    const cornerPackets = packets.filter(
      (p) => p.DistanceTraveled >= corner.distanceStart && p.DistanceTraveled <= corner.distanceEnd
    );
    if (cornerPackets.length === 0) continue;

    const speeds = cornerPackets.map(packetSpeed);
    const entrySpeed = speeds[0];
    const minSpeed = Math.min(...speeds);
    const exitSpeed = speeds[speeds.length - 1];

    // Most common gear
    const gearCounts = new Map<number, number>();
    for (const p of cornerPackets) {
      gearCounts.set(p.Gear, (gearCounts.get(p.Gear) ?? 0) + 1);
    }
    let gear = 1;
    let maxCount = 0;
    for (const [g, c] of gearCounts) {
      if (g > 0 && c > maxCount) { gear = g; maxCount = c; }
    }

    // Braking distance: scan backwards from corner start to find where braking began
    const cornerStartDist = corner.distanceStart;
    let brakingDistance = 0;
    for (let i = packets.length - 1; i >= 0; i--) {
      if (packets[i].DistanceTraveled <= cornerStartDist && packets[i].Brake > 50) {
        brakingDistance = cornerStartDist - packets[i].DistanceTraveled;
        // Keep scanning back to find the start of the braking zone
        while (i > 0 && packets[i - 1].Brake > 50) {
          i--;
          brakingDistance = cornerStartDist - packets[i].DistanceTraveled;
        }
        break;
      }
    }

    // Time in corner (approximate from packet count at ~60Hz)
    const timeInCorner = cornerPackets.length / 60;

    // Avg throttle/brake
    const avgThrottle = cornerPackets.reduce((s, p) => s + p.Accel / 255, 0) / cornerPackets.length * 100;
    const avgBrake = cornerPackets.reduce((s, p) => s + p.Brake / 255, 0) / cornerPackets.length * 100;

    // Throttle application point (distance into corner where throttle > 50%)
    let throttleOnDist = 0;
    for (const p of cornerPackets) {
      if (p.Accel / 255 > 0.5) {
        throttleOnDist = p.DistanceTraveled - corner.distanceStart;
        break;
      }
    }

    // Oversteer/understeer indicator from tire slip angles
    const avgFrontSlip = cornerPackets.reduce((s, p) =>
      s + (Math.abs(p.TireSlipAngleFL) + Math.abs(p.TireSlipAngleFR)) / 2, 0) / cornerPackets.length;
    const avgRearSlip = cornerPackets.reduce((s, p) =>
      s + (Math.abs(p.TireSlipAngleRL) + Math.abs(p.TireSlipAngleRR)) / 2, 0) / cornerPackets.length;
    const balance = avgRearSlip > avgFrontSlip * 1.3 ? "oversteer"
      : avgFrontSlip > avgRearSlip * 1.3 ? "understeer" : "neutral";

    metrics.push({
      label: corner.label,
      entrySpeed,
      minSpeed,
      exitSpeed,
      gear,
      brakingDistance,
      timeInCorner,
      avgThrottle,
      avgBrake,
      throttleOnDist,
      balance,
    });
  }

  if (metrics.length === 0) return "";

  // Format as text table
  let out = "\n--- Corner-by-Corner Data ---\n";
  out += "Corner | Entry mph | Min mph | Exit mph | Gear | Brake dist m | Time s | Throttle% | Brake% | Throttle-on m | Balance\n";
  out += "-------|-----------|---------|----------|------|-------------|--------|-----------|--------|--------------|--------\n";
  for (const m of metrics) {
    out += `${m.label.padEnd(6)} | ${m.entrySpeed.toFixed(0).padStart(9)} | ${m.minSpeed.toFixed(0).padStart(7)} | ${m.exitSpeed.toFixed(0).padStart(8)} | ${m.gear.toString().padStart(4)} | ${m.brakingDistance.toFixed(0).padStart(11)} | ${m.timeInCorner.toFixed(1).padStart(6)} | ${m.avgThrottle.toFixed(0).padStart(9)} | ${m.avgBrake.toFixed(0).padStart(5)} | ${m.throttleOnDist.toFixed(0).padStart(12)} | ${m.balance}\n`;
  }

  // Identify top 5 problem corners (lowest exit speed relative to entry)
  const sorted = [...metrics].sort((a, b) => {
    const ratioA = a.exitSpeed / (a.entrySpeed || 1);
    const ratioB = b.exitSpeed / (b.entrySpeed || 1);
    return ratioA - ratioB;
  });
  const problems = sorted.slice(0, 5);
  out += `\nTop problem corners (lowest exit/entry speed ratio): ${problems.map(p => p.label).join(", ")}\n`;

  return out;
}
```

- [ ] **Step 2: Create `server/ai/analyst-prompt.ts`**

```typescript
import type { TelemetryPacket } from "../../shared/types";
import { generateExport } from "../export";
import { getCarName, getTrackName } from "../../shared/car-data";
import { buildCornerData } from "./corner-data";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

const SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST follow this exact structure using markdown headers:

## Performance Summary
2-3 sentences assessing the overall lap quality — pace, consistency, and where the biggest time gains are hiding.

## Strengths
3-5 bullet points of what the driver did well. Reference specific telemetry values (speeds, percentages, corner names).

## Weaknesses
3-5 bullet points of areas for improvement. Be specific — cite corner names, speeds, brake/throttle percentages.

## Problem Corners
For each of the top 3-5 corners where time is being lost:
- **Corner name**: What's wrong and how to fix it (braking point, line, gear choice, exit speed).

## Driving Technique
3-5 actionable tips based on the telemetry patterns (trail braking, throttle modulation, racing line, gear selection, etc.).

## Tuning Recommendations
3-5 specific tuning changes based on the telemetry data (suspension, aero, gearing, differential, tire pressure). Explain the symptom you see in the data and the tuning change that addresses it.

RULES:
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Keep total output under 800 words
- Use markdown formatting
- Address the driver as "you"`;

export function buildAnalystPrompt(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[],
  corners: CornerDef[]
): string {
  const carName = getCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0);
  const trackName = getTrackName(lap.trackOrdinal ?? 0);

  // Base telemetry export
  const exportText = generateExport(lap, packets);

  // Corner-level data
  const cornerData = buildCornerData(packets, corners);

  // Enrich with human-readable names
  const context = `Car: ${carName}
Track: ${trackName}

${exportText}
${cornerData}`;

  return `${SYSTEM_PROMPT}

--- TELEMETRY DATA ---

${context}`;
}
```

- [ ] **Step 3: Verify imports resolve**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun build server/ai/analyst-prompt.ts --no-bundle 2>&1 | head -5`
Expected: No import errors.

- [ ] **Step 4: Commit**

```bash
git add server/ai/analyst-prompt.ts server/ai/corner-data.ts
git commit -m "feat: add AI analyst prompt template and corner data builder"
```

---

### Task 4: Server endpoint — `POST /api/laps/:id/analyse`

**Files:**
- Modify: `server/routes.ts`

- [ ] **Step 1: Add the analyse endpoint in `server/routes.ts`**

Add imports at the top:

```typescript
import { getAnalysis, saveAnalysis } from "./db/queries";
import { buildAnalystPrompt } from "./ai/analyst-prompt";
import { getCorners } from "./db/queries"; // already imported — just verify
```

Add the endpoint after the existing `GET /api/laps/:id/export` route (around line 146):

```typescript
// POST /api/laps/:id/analyse — AI-powered lap analysis via Claude CLI
app.post("/api/laps/:id/analyse", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);

  const url = new URL(c.req.url);
  const regenerate = url.searchParams.get("regenerate") === "true";

  // Check cache first
  if (!regenerate) {
    const cached = getAnalysis(id);
    if (cached) {
      return c.json({ analysis: cached, cached: true });
    }
  }

  const lap = getLapById(id);
  if (!lap) return c.json({ error: "Lap not found" }, 404);
  if (lap.telemetry.length === 0) {
    return c.json({ error: "No telemetry data" }, 400);
  }

  // Get corner definitions for the track
  const trackOrdinal = lap.trackOrdinal ?? 0;
  const corners = trackOrdinal > 0 ? getCorners(trackOrdinal) : [];

  // Build prompt
  const prompt = buildAnalystPrompt(lap, lap.telemetry, corners);

  // Spawn claude CLI, pipe prompt via stdin
  try {
    const proc = Bun.spawn(["claude", "-p", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write prompt to stdin (Bun.spawn stdin is a FileSink)
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Start reading stdout concurrently before awaiting exit
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    // Set up timeout (90 seconds)
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 90_000);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (timedOut) {
      return c.json({ error: "Analysis timed out" }, 504);
    }

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      console.error("[AI] Claude CLI failed:", stderr);
      return c.json({ error: "AI analysis failed. Is Claude CLI installed and authenticated?" }, 500);
    }

    const analysis = await stdoutPromise;
    if (!analysis.trim()) {
      return c.json({ error: "AI returned empty response" }, 500);
    }

    // Cache the result
    saveAnalysis(id, analysis.trim());

    return c.json({ analysis: analysis.trim(), cached: false });
  } catch (err) {
    console.error("[AI] Failed to spawn claude:", err);
    return c.json(
      { error: "Failed to run Claude CLI. Make sure 'claude' is installed and in PATH." },
      500
    );
  }
});
```

- [ ] **Step 2: Verify server starts and endpoint is reachable**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun run server/index.ts`
Expected: Server starts. Test with `curl -X POST http://localhost:3117/api/laps/1/analyse` — should return either analysis or a "Lap not found" / error (depending on data).

- [ ] **Step 3: Commit**

```bash
git add server/routes.ts
git commit -m "feat: add POST /api/laps/:id/analyse endpoint"
```

---

### Task 5: Install `react-markdown` dependency

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Install react-markdown**

```bash
cd /Users/acoop/Documents/GitHub/forza-telemetry/client && bun add react-markdown
```

- [ ] **Step 2: Commit**

```bash
git add client/package.json client/bun.lock
git commit -m "chore: add react-markdown dependency"
```

---

### Task 6: Create `AiAnalysisModal` component

**Files:**
- Create: `client/src/components/AiAnalysisModal.tsx`

- [ ] **Step 1: Create the modal component**

```tsx
import { useState, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { Sparkles, X, RefreshCw } from "lucide-react";

interface AiAnalysisModalProps {
  lapId: number;
  open: boolean;
  onClose: () => void;
  carName: string;
  trackName: string;
}

export function AiAnalysisModal({
  lapId,
  open,
  onClose,
  carName,
  trackName,
}: AiAnalysisModalProps) {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/laps/${lapId}/analyse${regenerate ? "?regenerate=true" : ""}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setAnalysis(data.analysis);
      } catch (err: any) {
        setError(err.message || "Failed to fetch analysis");
      } finally {
        setLoading(false);
      }
    },
    [lapId]
  );

  // Fetch on open
  useEffect(() => {
    if (open && lapId) {
      setAnalysis(null);
      fetchAnalysis(false);
    }
  }, [open, lapId, fetchAnalysis]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">
              AI Analysis — {carName} at {trackName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="size-8 border-2 border-slate-600 border-t-amber-400 rounded-full animate-spin" />
              <p className="text-sm text-slate-400">Analysing lap telemetry...</p>
              <p className="text-xs text-slate-600">This may take up to 90 seconds</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={() => fetchAnalysis(false)}
                className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {analysis && !loading && (
            <div className="prose prose-invert prose-sm max-w-none
              prose-headings:text-slate-200 prose-headings:font-semibold prose-headings:mt-5 prose-headings:mb-2
              prose-h2:text-base prose-h2:border-b prose-h2:border-slate-700/50 prose-h2:pb-1
              prose-p:text-slate-300 prose-p:leading-relaxed
              prose-li:text-slate-300
              prose-strong:text-white
              prose-ul:my-1 prose-li:my-0.5">
              <Markdown>{analysis}</Markdown>
            </div>
          )}
        </div>

        {/* Footer */}
        {analysis && !loading && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-700">
            <button
              onClick={() => fetchAnalysis(true)}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="size-3" />
              Regenerate
            </button>
            <button
              onClick={onClose}
              className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/AiAnalysisModal.tsx
git commit -m "feat: add AiAnalysisModal component"
```

---

### Task 7: Integrate AI Analysis button into LapAnalyse

**Files:**
- Modify: `client/src/components/LapAnalyse.tsx`

- [ ] **Step 1: Add imports at top of `LapAnalyse.tsx`**

Add these imports alongside the existing ones:

```typescript
import { AiAnalysisModal } from "./AiAnalysisModal";
import { Sparkles } from "lucide-react";
```

- [ ] **Step 2: Add state for modal in `LapAnalyse` component**

Inside the `LapAnalyse` function, near the other `useState` declarations, add:

```typescript
const [aiModalOpen, setAiModalOpen] = useState(false);
```

- [ ] **Step 3: Add the AI Analysis button**

In the header bar, right after the existing "Export CSV" button (around line 1017), add:

```tsx
{telemetry.length > 0 && (
  <button
    onClick={() => setAiModalOpen(true)}
    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-amber-400 border border-slate-700 rounded px-3 py-1.5 transition-colors"
  >
    <Sparkles className="size-3" />
    AI Analysis
  </button>
)}
```

- [ ] **Step 4: Add the modal render**

At the end of the component's return JSX, just before the closing `</div>` of the root element, add:

```tsx
{selectedLapId && (
  <AiAnalysisModal
    lapId={selectedLapId}
    open={aiModalOpen}
    onClose={() => setAiModalOpen(false)}
    carName={carName}
    trackName={trackName}
  />
)}
```

- [ ] **Step 5: Verify the UI builds without errors**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && bun run build`
Expected: Build completes without TypeScript or bundling errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/LapAnalyse.tsx
git commit -m "feat: add AI Analysis button to analyse page"
```

---

### Task 8: Manual integration test

- [ ] **Step 1: Start the server**

```bash
cd /Users/acoop/Documents/GitHub/forza-telemetry && bun run dev
```

- [ ] **Step 2: Open the analyse page in a browser**

Navigate to the app, select a lap with telemetry data.

- [ ] **Step 3: Verify the AI Analysis button appears**

The button should appear in the header bar next to "Export CSV" when a lap is loaded.

- [ ] **Step 4: Click the button and verify the modal**

- Modal should open with loading spinner
- After Claude responds, markdown analysis should render with proper formatting
- "Regenerate" and "Close" buttons should appear in footer
- Clicking "Close" or the backdrop should dismiss the modal
- Clicking "Regenerate" should show loading again and fetch fresh analysis

- [ ] **Step 5: Verify caching works**

Click the button again for the same lap — should return instantly with cached result.

- [ ] **Step 6: Commit any fixes if needed**
