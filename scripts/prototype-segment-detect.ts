#!/usr/bin/env bun
/**
 * Inspect auto-segment detection on a track centerline.
 *
 * Usage: bun scripts/prototype-segment-detect.ts <gameId> <ordinal> [--list]
 * Example: bun scripts/prototype-segment-detect.ts fm-2023 32 --list
 */
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { initGameAdapters } from "../shared/games/init";
import type { GameId } from "../shared/types";
import { detectSegments, type DetectedSegment } from "../server/track-segment-detect";

initGameAdapters();

function fmt(s: DetectedSegment): string {
  const len = (s.distEnd - s.distStart).toFixed(0).padStart(5);
  if (s.type === "corner") {
    const dir = s.direction === "left" ? "L" : s.direction === "right" ? "R" : "—";
    return `T ${dir} ${s.distStart.toFixed(0).padStart(5)}→${s.distEnd.toFixed(0).padStart(5)}m  (${len}m)`;
  }
  return `S — ${s.distStart.toFixed(0).padStart(5)}→${s.distEnd.toFixed(0).padStart(5)}m  (${len}m)`;
}

const [, , gameIdArg, ordArg] = process.argv;
if (!gameIdArg || !ordArg) {
  console.error("Usage: bun scripts/prototype-segment-detect.ts <gameId> <ordinal> [--list]");
  process.exit(1);
}
const outline = getTrackOutlineByOrdinal(parseInt(ordArg, 10), gameIdArg as GameId);
if (!outline) {
  console.error(`No outline for ${gameIdArg}:${ordArg}`);
  process.exit(1);
}
const result = detectSegments(outline);
const corners = result.segments.filter((s) => s.type === "corner").length;
const straights = result.segments.filter((s) => s.type === "straight").length;
console.log(`Track: ${gameIdArg}:${ordArg}  ${outline.length} pts, ${(result.totalDist / 1000).toFixed(2)} km`);
console.log(`Segments → corners: ${corners}, straights: ${straights}, total: ${result.segments.length}`);
if (process.argv.includes("--list")) {
  result.segments.forEach((s, i) => console.log(`${(i + 1).toString().padStart(3)}: ${fmt(s)}`));
}
