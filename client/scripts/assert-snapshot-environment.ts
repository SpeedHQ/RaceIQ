#!/usr/bin/env bun

if (process.env.RACEIQ_CANONICAL_SNAPSHOT_ENV !== "1") {
  console.error("Snapshot baselines must come from the pinned Playwright Linux container. Run 'bun run snapshot:docker' instead.");
  process.exit(1);
}
