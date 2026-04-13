# Game Extraction Required Banner

**Date:** 2026-04-04  
**Status:** Approved

## Overview

When a user navigates to a game-specific home page (`/fm23` or `/f125`) and has not yet extracted track data for that game, show a non-dismissable inline banner at the top of the dashboard. The banner lets the user trigger extraction directly without leaving the page.

## Scope

- Applies to FM2023 (`/fm23`) and F1 2025 (`/f125`) only — ACC has no file-based extraction.
- Does not appear on the global homepage (`/`) — that page is game-agnostic.
- Does not appear if extraction has already been completed (`extracted === true`).

## Data

Use the existing `GET /api/games/detection` endpoint which returns per-game:
- `installed: boolean` — whether the game is installed
- `extracted: boolean` — whether track data has been extracted
- `extractionStatus: "idle" | "running" | "done" | "error"`
- `trackCount: number`

While extraction is running, poll the relevant status endpoint every 500ms:
- FM2023: `GET /api/extraction/status`
- F1 2025: `GET /api/extraction/f1/status`

To trigger extraction:
- FM2023: `POST /api/extraction/run`
- F1 2025: `POST /api/extraction/f1/run`

## Banner States

### Idle (not extracted)
- Game-themed color strip (cyan for FM, red for F1)
- Left side: warning icon + bold "Track data not extracted" + sub-text "Extract track outlines from your [Game Name] installation for accurate track maps."
- Right side: "Extract Track Data" button (disabled if `installed === false`, with tooltip "Game not installed")

### Running
- Same banner, button replaced with disabled "Extracting…"
- Thin progress bar at the bottom edge of the banner
- Track counter: "12 / 28 tracks" shown next to the button area

### Done
- Banner unmounts — detection query is refetched after extraction completes, `extracted` becomes `true`, banner condition is no longer met

### Error
- Banner stays visible with red tint and error message + a "Retry" button

## Component Structure

A single `ExtractionBanner` component added to `client/src/components/HomePage.tsx`. No new files.

- Owns local state for extraction progress (running, count, total, error)
- Queries `GET /api/games/detection` via TanStack Query (shared with the rest of the page if possible)
- Rendered at the top of `HomePage`'s JSX, above the stats grid, only when `gameId` is set and extraction is needed

## Placement in HomePage

```
<div className="max-w-5xl mx-auto p-6 space-y-6">
  <ExtractionBanner gameId={gameId} />   ← inserted here
  {/* Header */}
  {/* Game cards (global only) */}
  {/* Stats grid */}
  ...
</div>
```
