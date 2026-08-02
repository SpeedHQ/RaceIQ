/**
 * Two-panel comparison of a MoTeC-reconstructed lap against the game's own track.
 *
 * Left is the track exactly as the app draws it. Right is the same track with the
 * reconstruction laid over it. Both panels share one projection, so a
 * reconstruction that is rotated, mirrored or scaled wrong sits visibly off the
 * grey track instead of quietly agreeing with a normalised reference.
 *
 * ## Why both panels are in display space
 *
 * Centerline CSVs hold RAW game coordinates. The telemetry pipeline negates
 * `PositionX` for standard-xyz games (`server/telemetry/live-pipeline.ts`), so what the app
 * renders is the *flipped* form — hence `needsTrackFlip`/`flipPoints`, the same
 * helpers the track-segment renders use, and `makeTrackProjection`, the same
 * projection the UI uses.
 *
 * The reconstruction gets the identical flip, because a real import goes through
 * that pipeline and will be negated too. Rendering the reconstruction in raw
 * space next to a flipped track would show a mirror that does not exist in the
 * product — and, worse, would hide a real one.
 *
 * Committed as artifacts, so a change to the dead-reckoning shows up as a
 * reviewable image diff.
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import type { GameId } from "../../shared/types";
import { flipPoints, needsTrackFlip, type Pt } from "../../shared/track-coords";
import { makeTrackProjection } from "../../shared/track-projection";
import type { Point } from "./motec-from-centerline";

const PANEL_W = 600;
const PANEL_H = 560;
const HEADER_H = 60;

export interface OverlayStats {
  meanDeviationM: number;
  maxDeviationM: number;
  /** True when reference and reconstruction wind the same way. */
  handednessMatches: boolean;
}

export function writeOverlaySvg(
  outputDir: string,
  name: string,
  gameId: GameId,
  /** Track centerline in RAW game coordinates, as stored in the CSV. */
  centerlineRaw: Point[],
  /** Reconstruction, already aligned back into the centerline's frame. */
  reconstructedRaw: Point[],
  stats: OverlayStats,
): void {
  // Into display space — the same flip the UI and the track-segment renders apply.
  const flip = needsTrackFlip(gameId);
  const track = flip ? flipPoints(centerlineRaw) : centerlineRaw;
  const reconstructed = flip ? flipPoints(reconstructedRaw) : reconstructedRaw;

  // One projection for both panels, fitted to the track so the reconstruction is
  // measured against it rather than being rescaled to fit its own bounds.
  const projection = makeTrackProjection(track, {
    width: PANEL_W,
    height: PANEL_H,
    padFrac: 0.08,
  });
  if (!projection) throw new Error(`degenerate centerline for "${name}": cannot project`);
  const project = (p: Pt) => projection.project(p);

  const trackPts = track.map(project).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const reconPts = reconstructed
    .map(project)
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const start = project(reconstructed[0]!);

  const width = PANEL_W * 2;
  const height = PANEL_H + HEADER_H;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .bg { fill: #ffffff; }
      .track { fill: none; stroke: #9ca3af; stroke-width: 6; stroke-linejoin: round; stroke-linecap: round; }
      .recon { fill: none; stroke: #3b82f6; stroke-width: 2; stroke-linejoin: round; }
      .start { fill: #10b981; }
      .divider { stroke: #e5e7eb; stroke-width: 1; }
      .title { font-family: monospace; font-size: 13px; fill: #111827; }
      .muted { font-family: monospace; font-size: 11px; fill: #6b7280; }
    </style>
  </defs>
  <rect class="bg" width="${width}" height="${height}" />

  <text class="title" x="12" y="20">${name}</text>
  <text class="muted" x="12" y="38">left: game track as the app draws it — right: MoTeC reconstruction (blue) over it</text>
  <text class="muted" x="12" y="52">mean ${stats.meanDeviationM.toFixed(1)} m · max ${stats.maxDeviationM.toFixed(1)} m · <tspan fill="${stats.handednessMatches ? "#10b981" : "#ef4444"}">handedness ${stats.handednessMatches ? "matches" : "MIRRORED"}</tspan></text>

  <line class="divider" x1="${PANEL_W}" y1="${HEADER_H}" x2="${PANEL_W}" y2="${height}" />

  <!-- Left: the game's own track, display space -->
  <g transform="translate(0, ${HEADER_H})">
    <polyline class="track" points="${trackPts}" />
  </g>

  <!-- Right: same projection, reconstruction laid over the track -->
  <g transform="translate(${PANEL_W}, ${HEADER_H})">
    <polyline class="track" points="${trackPts}" />
    <polyline class="recon" points="${reconPts}" />
    <circle class="start" cx="${start.x.toFixed(2)}" cy="${start.y.toFixed(2)}" r="5" />
  </g>
</svg>`;

  writeFileSync(resolve(outputDir, `${name}.svg`), svg);
}
