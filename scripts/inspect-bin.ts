/**
 * inspect-bin.ts — one-shot diagnostic for session .bin / .bin.gz files.
 *
 * Usage:
 *   bun scripts/inspect-bin.ts <path-to-bin> [--game <gameId>] [--no-import]
 *
 * Stages:
 *   1. Header: gzip detection, magic bytes, hex dump of first 64 bytes
 *   2. Game detection: filename + buffer sniffing
 *   3. Full import (unless --no-import): packet count, laps, car/track resolution
 */
import { readFileSync } from "fs";
import { basename } from "path";
import { gunzipSync } from "zlib";
import { initServerGameAdapters } from "../server/games/init";
import {
  importSessionBin,
  detectGameIdFromBuffer,
  detectGameIdFromFilename,
} from "../server/session-capture/import-capture";
import { getAcEvoTrackName } from "../shared/racing/tracks/catalogs/ac-evo"
import type { GameId } from "../shared/games/ids";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const gameFlagIdx = args.indexOf("--game");
const gameOverride = gameFlagIdx >= 0 ? (args[gameFlagIdx + 1] as GameId) : null;
const noImport = args.includes("--no-import");

if (!path) {
  console.error("Usage: bun scripts/inspect-bin.ts <path-to-bin> [--game <gameId>] [--no-import]");
  process.exit(1);
}

initServerGameAdapters();

// ── Stage 1: header ──────────────────────────────────────────────
const raw = readFileSync(path);
const isGz = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
const buf = isGz ? gunzipSync(raw) : raw;

console.log(`=== ${basename(path)} ===`);
console.log(`raw size:     ${raw.length} bytes${isGz ? " (gzip)" : ""}`);
console.log(`decompressed: ${buf.length} bytes`);
console.log(`first 64 bytes:`);
for (let off = 0; off < Math.min(64, buf.length); off += 16) {
  const slice = buf.subarray(off, off + 16);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
  console.log(`  ${off.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${ascii}`);
}

// ── Stage 2: game detection ──────────────────────────────────────
const fromName = detectGameIdFromFilename(basename(path));
const fromBuf = detectGameIdFromBuffer(buf);
console.log(`\ngame from filename: ${fromName ?? "(none)"}`);
console.log(`game from buffer:   ${fromBuf ?? "(none)"}`);

const gameId = gameOverride ?? fromBuf ?? fromName;
if (!gameId) {
  console.error("\nFAIL: could not detect game. Pass --game <gameId>.");
  process.exit(1);
}
console.log(`using game:         ${gameId}${gameOverride ? " (override)" : ""}`);

if (noImport) process.exit(0);

// ── Stage 3: full import ─────────────────────────────────────────
console.log("\n--- import ---");
const result = await importSessionBin(buf, gameId);
console.log(`packets: ${result.packetCount}  laps: ${result.laps.length}`);

if (result.packetCount === 0) {
  console.error("FAIL: 0 packets parsed — frame format or parser mismatch.");
  process.exit(1);
}

for (const lap of result.laps) {
  const trackName =
    gameId === "ac-evo" ? getAcEvoTrackName(lap.trackOrdinal) : `ordinal ${lap.trackOrdinal}`;
  const bad = /unknown/i.test(trackName) ? "  <-- UNKNOWN TRACK" : "";
  console.log(
    `lap ${lap.lapNumber}  time=${lap.lapTime}  carOrd=${lap.carOrdinal}  trackOrd=${lap.trackOrdinal}  track="${trackName}"${bad}`
  );
}

if (result.laps.length === 0) {
  console.warn("WARN: packets parsed but no laps detected — check lap detector / session type.");
}
