/**
 * Parse AI spline data from F1 25 ERP archives.
 * Extracts gate centerline points, racing limits, and track limits.
 *
 * Usage: bun run scripts/games/f1-2025/parse-ai-spline.ts [file.erp] [output-dir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import * as fzstd from "fzstd";
import { extractMatchingErpFragments } from "./lib/erp";
import { parseBxml } from "./lib/bxml";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_ERP = "C:/Program Files (x86)/Steam/steamapps/common/F1 25/2025_asset_groups/environment_package/tracks/abu_dhabi/wep/abu_dhabi_common.erp";
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "scripts/track-data");

function readArchive(path: string): Buffer {
  return Buffer.from(readFileSync(path));
}

function decodeAiSpline(archive: Buffer): Buffer[] {
  return extractMatchingErpFragments(archive, "aispline").map(({ fragment, data }) => fragment.compression === 0x11 ? Buffer.from(fzstd.decompress(new Uint8Array(data))) : Buffer.from(data));
}
function main() {
  const erpPath = process.argv[2] || DEFAULT_ERP;
  const outputDir = process.argv[3] || DEFAULT_OUTPUT_DIR;
  console.log(`Reading ERP: ${erpPath}`);
  const fragments = decodeAiSpline(readArchive(erpPath));
  console.log(`Found ${fragments.length} fragments`);
  if (fragments.length === 0) {
    console.error("No aispline data found!");
    process.exit(1);
  }

  const gates = parseBxml(fragments[0]);
  console.log(`BXML data size: ${fragments[0].length} bytes`);
  console.log(`Parsed ${gates.length} gates`);
  if (gates.length === 0) return;

  console.log("\nFirst 5 gates:");
  for (let i = 0; i < Math.min(5, gates.length); i++) {
    const gate = gates[i];
    console.log(`  Gate ${gate.id} (${gate.name}): pos=(${gate.position.x}, ${gate.position.y}, ${gate.position.z}) normal=(${gate.normal.x}, ${gate.normal.y}, ${gate.normal.z})`);
    for (const waypoint of gate.waypoints) console.log(`    Waypoint ${waypoint.id}: ${waypoint.type} length=${waypoint.length}`);
  }

  console.log("\nLast 3 gates:");
  for (let i = Math.max(0, gates.length - 3); i < gates.length; i++) {
    const gate = gates[i];
    console.log(`  Gate ${gate.id} (${gate.name}): pos=(${gate.position.x}, ${gate.position.y}, ${gate.position.z})`);
  }

  const widths = gates.map((gate) => {
    const left = gate.waypoints.find((waypoint) => waypoint.type === "left_track_limit");
    const right = gate.waypoints.find((waypoint) => waypoint.type === "right_track_limit");
    return left && right ? Math.abs(right.length - left.length) : null;
  }).filter((width): width is number => width !== null);
  if (widths.length > 0) {
    console.log(`\nTrack width stats (${widths.length} measurements):`);
    console.log(`  Min: ${Math.min(...widths).toFixed(2)}m`);
    console.log(`  Max: ${Math.max(...widths).toFixed(2)}m`);
    console.log(`  Avg: ${(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(2)}m`);
  }

  const waypointTypes = new Set(gates.flatMap((gate) => gate.waypoints.map((waypoint) => waypoint.type)));
  console.log(`\nWaypoint types: ${[...waypointTypes].join(", ")}`);
  mkdirSync(outputDir, { recursive: true });
  const output = {
    trackName: "abu_dhabi",
    gateCount: gates.length,
    waypointTypes: [...waypointTypes],
    gates: gates.map((gate) => ({
      id: gate.id,
      name: gate.name,
      x: gate.position.x,
      y: gate.position.y,
      z: gate.position.z,
      nx: gate.normal.x,
      ny: gate.normal.y,
      nz: gate.normal.z,
      waypoints: gate.waypoints,
    })),
  };
  const outputFile = join(outputDir, "abu_dhabi_aispline.json");
  writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to: ${outputFile}`);
}

main();
