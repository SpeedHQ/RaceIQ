/**
 * Draws a MoTeC-reconstructed lap on top of the centerline it was derived from.
 *
 * Committed as artifacts, same convention as the track-segment and lap-detection
 * visualizations: a change to the dead-reckoning shows up as a reviewable diff
 * rather than only as a moved number. The two paths should sit on top of each
 * other; a mirrored reconstruction is obvious at a glance even when a tolerance
 * might still pass.
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import type { Point } from "./motec-from-centerline";

const WIDTH = 800;
const HEIGHT = 600;
const PADDING = 40;

export interface OverlayStats {
  meanDeviationM: number;
  maxDeviationM: number;
  /** True when reference and reconstruction wind the same way. */
  handednessMatches: boolean;
}

/** Fit both paths into one viewport so they are directly comparable. */
function projector(all: Point[]) {
  const xs = all.map((p) => p.x);
  const zs = all.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;
  const scale = Math.min((WIDTH - PADDING * 2) / spanX, (HEIGHT - PADDING * 2) / spanZ);
  const offX = (WIDTH - spanX * scale) / 2;
  const offZ = (HEIGHT - spanZ * scale) / 2;

  return (p: Point) => {
    const x = offX + (p.x - minX) * scale;
    // Flip Z so north is up, matching the other track renders.
    const y = HEIGHT - (offZ + (p.z - minZ) * scale);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
}

export function writeOverlaySvg(
  outputDir: string,
  name: string,
  reference: Point[],
  reconstructed: Point[],
  stats: OverlayStats,
): void {
  const project = projector([...reference, ...reconstructed]);
  const refPts = reference.map(project).join(" ");
  const recPts = reconstructed.map(project).join(" ");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <style>
      .reference { fill: none; stroke: #9ca3af; stroke-width: 6; stroke-linejoin: round; }
      .reconstructed { fill: none; stroke: #3b82f6; stroke-width: 2; stroke-linejoin: round; }
      .start { fill: #10b981; r: 5; }
      .label { font-family: monospace; font-size: 12px; fill: #374151; }
      .muted { font-family: monospace; font-size: 11px; fill: #6b7280; }
    </style>
  </defs>

  <!-- Grey: the centerline the channels were derived from -->
  <polyline class="reference" points="${refPts}" />
  <!-- Blue: what the transcoder reconstructed from speed + yaw alone -->
  <polyline class="reconstructed" points="${recPts}" />
  <circle class="start" cx="${project(reconstructed[0]!).split(",")[0]}" cy="${project(reconstructed[0]!).split(",")[1]}" />

  <text class="label" x="10" y="20">${name}</text>
  <text class="muted" x="10" y="38">grey: centerline (truth) — blue: dead-reckoned from speed + yaw</text>
  <text class="muted" x="10" y="54">mean deviation: ${stats.meanDeviationM.toFixed(1)} m</text>
  <text class="muted" x="10" y="70">max deviation: ${stats.maxDeviationM.toFixed(1)} m</text>
  <text class="muted" x="10" y="86" fill="${stats.handednessMatches ? "#10b981" : "#ef4444"}">handedness: ${stats.handednessMatches ? "matches" : "MIRRORED"}</text>
</svg>`;

  writeFileSync(resolve(outputDir, `${name}.svg`), svg);
}
