# Game Extraction Required Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a non-dismissable inline banner on game-specific home pages when track data hasn't been extracted yet, allowing the user to trigger extraction directly from the page.

**Architecture:** Add an `ExtractionBanner` component inside `client/src/components/HomePage.tsx`. It queries `GET /api/games/detection` (Hono RPC typed client), renders conditionally based on `gameId` and extraction status, and drives extraction via `POST /api/extraction/run` or `POST /api/extraction/f1/run`. Progress is polled from the respective status endpoint while running.

**Tech Stack:** React 19, TanStack Query, Hono RPC client (`client` from `@/lib/rpc`), Tailwind CSS v4, shadcn Button

---

### Task 1: Add `ExtractionBanner` component to `HomePage.tsx`

**Files:**
- Modify: `client/src/components/HomePage.tsx`

- [ ] **Step 1: Add the `ExtractionBanner` component**

Insert this component definition into `client/src/components/HomePage.tsx`, before the `HomePage` function. Add `useCallback` to the React import.

```tsx
type ExtractionStatus = {
  status: string;
  installed: boolean;
  extracted: number;
  failed: number;
  total: number;
  current: string;
  error?: string;
};

function ExtractionBanner({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const [pollEnabled, setPollEnabled] = useState(false);

  // Detection query — tells us installed + extracted state
  const { data: detection } = useQuery({
    queryKey: ["games-detection"],
    queryFn: () => client.api.games.detection.$get().then((r) => r.json()),
    refetchInterval: pollEnabled ? 500 : false,
  });

  const gameDetection = detection?.[gameId as "fm-2023" | "f1-2025"];

  // Per-game extraction status (polled while running)
  const { data: extractionStatus } = useQuery<ExtractionStatus>({
    queryKey: ["extraction-status", gameId],
    queryFn: () =>
      gameId === "f1-2025"
        ? client.api.extraction.f1.status.$get().then((r) => r.json())
        : client.api.extraction.status.$get().then((r) => r.json()),
    enabled: pollEnabled,
    refetchInterval: pollEnabled ? 500 : false,
  });

  const isRunning = extractionStatus?.status === "running" || pollEnabled && extractionStatus?.status === undefined;
  const isDone = gameDetection?.extracted === true;
  const isError = extractionStatus?.status === "error";
  const progress = extractionStatus && extractionStatus.total > 0
    ? Math.round((extractionStatus.extracted + extractionStatus.failed) / extractionStatus.total * 100)
    : 0;

  // Stop polling once done
  useEffect(() => {
    if (extractionStatus?.status === "done") {
      setPollEnabled(false);
      queryClient.invalidateQueries({ queryKey: ["games-detection"] });
    }
  }, [extractionStatus?.status, queryClient]);

  // Only show for FM2023 and F1-2025, only when not yet extracted
  if (!gameDetection || isDone) return null;

  const handleExtract = async () => {
    setPollEnabled(true);
    if (gameId === "f1-2025") {
      await client.api.extraction.f1.run.$post();
    } else {
      await client.api.extraction.run.$post();
    }
  };

  const accentColor = gameId === "f1-2025"
    ? { border: "border-red-500/30", bg: "bg-red-500/8", text: "text-red-400", bar: "bg-red-500" }
    : { border: "border-cyan-500/30", bg: "bg-cyan-500/8", text: "text-cyan-400", bar: "bg-cyan-500" };

  const gameName = gameId === "f1-2025" ? "F1 25" : "Forza Motorsport 2023";

  return (
    <div className={`relative rounded-lg border ${accentColor.border} ${accentColor.bg} overflow-hidden`}>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        {/* Left: icon + text */}
        <div className="flex items-start gap-3 min-w-0">
          <svg className={`w-4 h-4 mt-0.5 shrink-0 ${accentColor.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-app-text leading-tight">
              Track data not extracted
            </p>
            {isError ? (
              <p className="text-xs text-red-400 mt-0.5">{extractionStatus?.error ?? "Extraction failed"}</p>
            ) : isRunning ? (
              <p className="text-xs text-app-text-muted mt-0.5">
                {extractionStatus?.current
                  ? `Extracting ${extractionStatus.current}…`
                  : "Starting extraction…"}
                {extractionStatus && extractionStatus.total > 0 && (
                  <span className="ml-1 tabular-nums">
                    ({extractionStatus.extracted}/{extractionStatus.total})
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-app-text-muted mt-0.5">
                Extract track outlines from your {gameName} installation for accurate track maps.
                {gameDetection.installed
                  ? <span className={`ml-1 ${accentColor.text}`}>Game installation detected.</span>
                  : <span className="ml-1 text-app-text-dim">Game installation not found — you can still extract if installed elsewhere.</span>
                }
              </p>
            )}
          </div>
        </div>

        {/* Right: button */}
        <div className="shrink-0">
          <Button
            size="sm"
            variant={isError ? "destructive" : "default"}
            disabled={isRunning}
            onClick={handleExtract}
            className="text-xs"
          >
            {isRunning ? "Extracting…" : isError ? "Retry" : "Extract Track Data"}
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      {isRunning && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-app-border">
          <div
            className={`h-full transition-all duration-300 ${accentColor.bar}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update imports in `HomePage.tsx`**

Add `useQueryClient` to the existing imports. The top of the file should have:

```tsx
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
```

Also add the `Button` import (shadcn):

```tsx
import { Button } from "./ui/button";
```

- [ ] **Step 3: Render `ExtractionBanner` inside `HomePage`**

In the `HomePage` function's return JSX, insert `<ExtractionBanner>` as the first child inside the outer `div`, but only for games that support extraction. Replace this existing block:

```tsx
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
```

with:

```tsx
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Extraction banner — FM2023 and F1-2025 only */}
      {(gameId === "fm-2023" || gameId === "f1-2025") && (
        <ExtractionBanner gameId={gameId} />
      )}
      {/* Header */}
```

- [ ] **Step 4: Verify the client builds**

```bash
cd client && bun run build
```

Expected: no TypeScript errors, build completes successfully.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/HomePage.tsx
git commit -m "feat: show extraction required banner on game home pages"
```
