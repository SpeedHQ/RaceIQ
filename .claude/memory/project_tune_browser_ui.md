---
name: project_tune_browser_ui
description: "Timing-tower tune browse UI — reusable presentational component, per-game container (FM only)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ed5e66de-b28f-43a0-923c-8839cbb1b8f6
---

New tune browsing UI ("timing-tower" design, mockup 5 of scratchpad/tunes-mockups). Plan: `docs/superpowers/plans/2026-07-12-tune-browser-ui.md`.

**Architecture:** game-agnostic presentational `TuneBrowser` (client/src/components/tune/browser/) + per-game container `Fm23TuneBrowser` (client/src/components/tune/fm23/). Tune feature is PER-GAME, never shared: FM = full (builtin JSON + community CDN + user tunes); F1 = own track-based setups (route redirects to /f125/tracks?tab=setups); ACC = none. Other games opt in by writing their own container.

**UI:** Track→Car searchable comboboxes (primary), source tabs All/Built-in/Community/Yours (label "Built-in" not "Official"), expandable row reusing TuneSettingsPanel, sortable Lap Time column.

**Key data facts (community CDN speedhq-tunes.pages.dev, fm-2023, 111 tunes/23 cars):** car is the real axis not track (only 10/111 are track-specific, rest `circuit` with no track). Tunes distinguished by `author` (swin87, artheof…). NO ratings/clone-counts in data. NO lap-time field — only ~3/111 descriptions state one; parsed client-side via parseLapTime util (Phase 1). Durable structured lapTime field in publisher = future follow-up. Units are FM: tire PSI ~28, spring ~500, final drive ~6.1.

**Hooks used:** useCatalogTunes (gameId-scoped via X-Game-Id), useUserTunes (NOT game-scoped — tunes table has no gameId), useResolveNames(trackOrdinals,carOrdinals), useCloneCatalogTune/useDeleteTune/useRefreshCommunityTunes.

Related: [[project_community_tunes_cdn]]
