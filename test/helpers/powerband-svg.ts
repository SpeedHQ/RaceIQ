import type { TelemetryPacket } from "../../shared/telemetry/types";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { computeGearingStateRaw } from "../../client/src/lib/session-gearing";

/**
 * Generate an SVG powerband visualization from telemetry packets.
 * Converts packets to display packets, computes gearing state, and renders
 * power/torque curves with peak markers and power band highlight.
 *
 * Output: <outputDir>/powerband.svg
 */
export function generatePowerbandSvg(
  packets: TelemetryPacket[],
  outputDir: string
): void {
  if (packets.length === 0) return;

  const state = computeGearingStateRaw(packets, packets[0].gameId);
  // Canonical watts → HP for the SVG readouts.
  const hpCurve = state.powerCurve.map((p) => ({ rpm: p.rpm, hp: p.powerW / WATTS_PER_HORSEPOWER }));

  const hasPower = state.powerCurve.length > 0;
  const hasTorque = state.torqueCurve.length > 0;

  // Extract engine RPM range from first packet
  const idleRpm = packets[0].EngineIdleRpm;
  const maxRpm = packets[0].EngineMaxRpm > 0 ? packets[0].EngineMaxRpm : 8000;

  const width = 800;
  const height = 400;
  const pad = { top: 20, right: 60, bottom: 40, left: 60 };
  const cW = width - pad.left - pad.right;
  const cH = height - pad.top - pad.bottom;

  const sx = (rpm: number) => pad.left + ((rpm - idleRpm) / (maxRpm - idleRpm)) * cW;
  const syHp = (hp: number, maxHp: number) => pad.top + cH - (hp / maxHp) * cH;
  const syNm = (nm: number, maxNm: number) => pad.top + cH - (nm / maxNm) * cH;

  const globalMaxHp = Math.max(1, ...(hasPower ? hpCurve.map((p) => p.hp) : [1])) * 1.05;
  const globalMaxNm = Math.max(1, ...(hasTorque ? state.torqueCurve.map((t) => t.nm) : [1])) * 1.05;

  // Find peak power and peak torque points
  let peakPower: { rpm: number; hp: number } | null = null;
  let peakTorque: { rpm: number; nm: number } | null = null;

  for (const p of hpCurve) {
    if (!peakPower || p.hp > peakPower.hp) peakPower = p;
  }
  for (const t of state.torqueCurve) {
    if (!peakTorque || t.nm > peakTorque.nm) peakTorque = t;
  }

  const svgParts: string[] = [];

  // Helper to escape XML
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  svgParts.push(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .grid-line { stroke: rgba(100,116,139,0.15); stroke-width: 1; }
      .axis-text { font-family: monospace; font-size: 11px; fill: #64748b; }
      .label-text { font-family: monospace; font-size: 12px; fill: #94a3b8; }
      .title-text { font-family: monospace; font-size: 13px; fill: #cbd5e1; font-weight: bold; }
      .power-line { fill: none; stroke: #22d3ee; stroke-width: 2.5; }
      .torque-line { fill: none; stroke: #a855f7; stroke-width: 2; stroke-dasharray: 5,4; }
      .redline { fill: none; stroke: #22c55e; stroke-width: 1; stroke-dasharray: 3,3; }
      .peak-marker { r: 4; }
      .band-label { font-family: monospace; font-size: 11px; fill: rgba(250,204,21,0.9); font-weight: bold; }
    </style>
  </defs>

  <!-- Background -->
  <rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a" />
  <rect x="${pad.left}" y="${pad.top}" width="${cW}" height="${cH}" fill="rgba(255,255,255,0.03)" />`);

  // Power band highlight
  if (peakTorque && peakPower && peakTorque.rpm < peakPower.rpm) {
    const x1 = sx(peakTorque.rpm);
    const x2 = sx(peakPower.rpm);
    svgParts.push(`  <rect x="${x1.toFixed(1)}" y="${pad.top}" width="${(x2 - x1).toFixed(1)}" height="${cH}" fill="rgba(250,204,21,0.12)" />`);
  }

  // RPM gridlines
  const rpmSteps = 5;
  for (let i = 0; i <= rpmSteps; i++) {
    const rpm = idleRpm + ((maxRpm - idleRpm) * i) / rpmSteps;
    const x = sx(rpm);
    svgParts.push(`  <line class="grid-line" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + cH}" />`);
    svgParts.push(`  <text class="axis-text" x="${x.toFixed(1)}" y="${pad.top + cH + 18}" text-anchor="middle">${Math.round(rpm / 1000)}k</text>`);
  }

  // Y-axis grids (HP left)
  for (let i = 0; i <= 2; i++) {
    const hp = (globalMaxHp * i) / 2;
    const y = syHp(hp, globalMaxHp);
    svgParts.push(`  <line class="grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + cW}" y2="${y.toFixed(1)}" />`);
    svgParts.push(`  <text class="axis-text" x="${pad.left - 8}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${hp.toFixed(0)}</text>`);
  }

  // Y-axis labels (Nm right)
  for (let i = 0; i <= 2; i++) {
    const nm = (globalMaxNm * i) / 2;
    const y = syNm(nm, globalMaxNm);
    svgParts.push(`  <text class="axis-text" x="${pad.left + cW + 8}" y="${y.toFixed(1)}" text-anchor="start" dominant-baseline="middle">${nm.toFixed(0)}</text>`);
  }

  // Axis labels
  svgParts.push(`  <text class="label-text" x="${pad.left + cW / 2}" y="${height - 6}" text-anchor="middle">RPM ×1000</text>`);
  svgParts.push(`  <text class="label-text" x="12" y="${pad.top + cH / 2}" text-anchor="middle" transform="rotate(-90, 12, ${pad.top + cH / 2})">HP</text>`);
  svgParts.push(`  <text class="label-text" x="${width - 12}" y="${pad.top + cH / 2}" text-anchor="middle" transform="rotate(90, ${width - 12}, ${pad.top + cH / 2})">Nm</text>`);

  // Decide label placement to avoid overlaps (ported from PowerBandChart.tsx)
  const px = peakPower ? sx(peakPower.rpm) : null;
  const tx = peakTorque ? sx(peakTorque.rpm) : null;
  let powerAbove = true;
  let torqueAbove = true;
  if (px != null && tx != null && Math.abs(px - tx) < 50) {
    powerAbove = true;
    torqueAbove = false;
  }

  // Redline
  const redX = sx(maxRpm);
  svgParts.push(`  <line class="redline" x1="${redX.toFixed(1)}" y1="${pad.top}" x2="${redX.toFixed(1)}" y2="${pad.top + cH}" />`);

  // Power line
  if (hasPower) {
    const d = hpCurve.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.rpm).toFixed(1)},${syHp(p.hp, globalMaxHp).toFixed(1)}`).join(" ");
    svgParts.push(`  <path class="power-line" d="${d}" />`);
  }

  // Torque line
  if (hasTorque) {
    const d = state.torqueCurve.map((t, i) => `${i === 0 ? "M" : "L"}${sx(t.rpm).toFixed(1)},${syNm(t.nm, globalMaxNm).toFixed(1)}`).join(" ");
    svgParts.push(`  <path class="torque-line" d="${d}" />`);
  }

  // Legend
  let legendX = pad.left + 4;
  const legendY = pad.top + 14;
  if (hasPower) {
    svgParts.push(`  <text class="title-text" x="${legendX}" y="${legendY}" fill="#22d3ee">Power</text>`);
    legendX += 46;
  }
  if (hasTorque) {
    svgParts.push(`  <text class="title-text" x="${legendX}" y="${legendY}" fill="#a855f7">Torque</text>`);
  }

  // Peak power marker + label
  if (peakPower && px != null) {
    const py = syHp(peakPower.hp, globalMaxHp);
    svgParts.push(`  <circle class="peak-marker" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" fill="#22d3ee" />`);
    const labelText = `P ${Math.round(peakPower.hp)} @ ${Math.round(peakPower.rpm)}`;
    const labelBgWidth = labelText.length * 7 + 10;
    const labelX = px - labelBgWidth / 2;
    const labelY = powerAbove ? py - 22 : py + 10;
    svgParts.push(`  <rect x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" width="${labelBgWidth}" height="18" rx="4" fill="rgba(0,0,0,0.6)" />`);
    svgParts.push(`  <text class="axis-text" x="${px.toFixed(1)}" y="${(labelY + 13).toFixed(1)}" text-anchor="middle" fill="#22d3ee" font-weight="bold" font-size="10px">${esc(labelText)}</text>`);
  }

  // Peak torque marker + label
  if (peakTorque && tx != null) {
    const ty = syNm(peakTorque.nm, globalMaxNm);
    svgParts.push(`  <circle class="peak-marker" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" fill="#a855f7" />`);
    const labelText = `T ${Math.round(peakTorque.nm)} @ ${Math.round(peakTorque.rpm)}`;
    const labelBgWidth = labelText.length * 7 + 10;
    const labelX = tx - labelBgWidth / 2;
    const labelY = torqueAbove ? ty - 22 : ty + 10;
    svgParts.push(`  <rect x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" width="${labelBgWidth}" height="18" rx="4" fill="rgba(0,0,0,0.6)" />`);
    svgParts.push(`  <text class="axis-text" x="${tx.toFixed(1)}" y="${(labelY + 13).toFixed(1)}" text-anchor="middle" fill="#a855f7" font-weight="bold" font-size="10px">${esc(labelText)}</text>`);
  }

  // Visual intersection of power and torque lines
  if (hasPower && hasTorque) {
    const crossRpm = findVisualCrossing(hpCurve, state.torqueCurve, globalMaxHp, globalMaxNm);
    if (crossRpm != null) {
      const cx = sx(crossRpm);
      svgParts.push(`  <line stroke="rgba(255,255,255,0.4)" stroke-width="1" stroke-dasharray="2,2" x1="${cx.toFixed(1)}" y1="${pad.top}" x2="${cx.toFixed(1)}" y2="${pad.top + cH}" />`);
      const crossLabel = `cross @ ${Math.round(crossRpm)}`;
      const crossBgWidth = crossLabel.length * 7 + 10;
      const crossX = cx - crossBgWidth / 2;
      const crossY = pad.top + cH - 24;
      svgParts.push(`  <rect x="${crossX.toFixed(1)}" y="${crossY.toFixed(1)}" width="${crossBgWidth}" height="18" rx="4" fill="rgba(0,0,0,0.6)" />`);
      svgParts.push(`  <text class="axis-text" x="${cx.toFixed(1)}" y="${(crossY + 13).toFixed(1)}" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-weight="bold" font-size="10px">${esc(crossLabel)}</text>`);
    }
  }

  // Power band label
  if (peakTorque && peakPower && peakTorque.rpm < peakPower.rpm) {
    const midX = (sx(peakTorque.rpm) + sx(peakPower.rpm)) / 2;
    // Prefer top of band, but nudge down if it would collide with peak labels
    let bandY = pad.top + 14;
    if (px != null && Math.abs(midX - px) < 40 && powerAbove) bandY = pad.top + 28;
    if (tx != null && Math.abs(midX - tx) < 40 && torqueAbove) bandY = pad.top + 28;
    svgParts.push(`  <text class="band-label" x="${midX.toFixed(1)}" y="${bandY}" text-anchor="middle">POWER BAND</text>`);
  }

  // Border
  svgParts.push(`  <rect x="${pad.left}" y="${pad.top}" width="${cW}" height="${cH}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1" />`);

  // Title
  svgParts.push(`  <text class="title-text" x="${width / 2}" y="14" text-anchor="middle">Power Band</text>`);

  // Stats
  const statsY = pad.top + cH + 48;
  svgParts.push(`  <text class="axis-text" x="${pad.left}" y="${statsY}" text-anchor="start">Samples: ${packets.length}</text>`);
  svgParts.push(`  <text class="axis-text" x="${pad.left + 160}" y="${statsY}" text-anchor="start">Power curve: ${state.powerCurve.length} pts</text>`);
  svgParts.push(`  <text class="axis-text" x="${pad.left + 340}" y="${statsY}" text-anchor="start">Torque curve: ${state.torqueCurve.length} pts</text>`);

  svgParts.push(`</svg>`);

  const filename = resolve(outputDir, "powerband.svg");
  writeFileSync(filename, svgParts.join("\n"));
}

/** Find the RPM where the visually-scaled power and torque lines cross */
function findVisualCrossing(
  powerCurve: { rpm: number; hp: number }[],
  torqueCurve: { rpm: number; nm: number }[],
  maxHp: number,
  maxNm: number
): number | null {
  if (powerCurve.length < 2 || torqueCurve.length < 2) return null;

  for (let i = 0; i < powerCurve.length - 1; i++) {
    const rpmA = powerCurve[i].rpm;
    const rpmB = powerCurve[i + 1].rpm;
    const hpA = powerCurve[i].hp;
    const hpB = powerCurve[i + 1].hp;

    const nmA = interpolateValue(torqueCurve, rpmA, "nm");
    const nmB = interpolateValue(torqueCurve, rpmB, "nm");

    const yHpA = hpA / maxHp;
    const yHpB = hpB / maxHp;
    const yNmA = nmA / maxNm;
    const yNmB = nmB / maxNm;

    const diffA = yHpA - yNmA;
    const diffB = yHpB - yNmB;

    if (diffA === 0) return rpmA;
    if (diffB === 0) return rpmB;
    if (diffA * diffB < 0) {
      const t = Math.abs(diffA) / (Math.abs(diffA) + Math.abs(diffB));
      return rpmA + t * (rpmB - rpmA);
    }
  }
  return null;
}

/** Linearly interpolate a value from a sorted curve */
function interpolateValue<T extends { rpm: number }>(
  curve: T[],
  rpm: number,
  key: keyof T
): number {
  if (curve.length === 0) return 0;
  if (rpm <= curve[0].rpm) return curve[0][key] as number;
  if (rpm >= curve[curve.length - 1].rpm) return curve[curve.length - 1][key] as number;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (rpm >= a.rpm && rpm <= b.rpm) {
      const t = (rpm - a.rpm) / (b.rpm - a.rpm);
      return (a[key] as number) + t * ((b[key] as number) - (a[key] as number));
    }
  }
  return 0;
}
