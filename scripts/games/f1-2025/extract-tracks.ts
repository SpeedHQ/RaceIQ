/**
 * Extract F1 25 track geometry from game AI spline data for all tracks.
 *
 * Usage: bun run scripts/games/f1-2025/extract-tracks.ts
 */
import { resolve } from "path";
import { runTrackExtraction } from "./lib/extract-tracks";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
runTrackExtraction(REPO_ROOT);
