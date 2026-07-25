/**
 * Extract unique AC Evo car display names from `.bin` recordings in
 * test/artifacts/sessions and diff against cars.csv.
 *
 * Reads SPageFileGraphicEvo.car_model (char[33] at offset 3086) from each
 * recording's first populated graphics frame — that's the authoritative
 * display name the game wrote to shared memory while you were driving.
 *
 * Usage:
 *   bun run scripts/extract-ac-evo-cars.ts [kspkg]        # full car list from content.kspkg, appends new rows
 *   bun run scripts/extract-ac-evo-cars.ts --recordings   # scan .bin recordings instead
 *
 * Default mode reads system\cars.table out of the game's content.kspkg
 * (auto-located via AC_EVO_KSPKG or common Steam paths) and diffs the full
 * shipped car list against cars.csv — run it after any game update to pick
 * up every new car (real model slug + brand included), no driving required.
 */
import { readFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { GRAPHICS_EVO } from "../server/games/ac-evo/structs";
import { readCString } from "../server/games/ac-evo/utils";
import { getAllAcEvoCars, getAcEvoCarByDisplayName } from "../shared/ac-evo-car-data";
import { Kspkg, findContentKspkg } from "../server/games/ac-evo/kspkg";
import { parseCarsTable } from "../server/games/ac-evo/kspkg-tables";
import { runSetupRangesExtraction } from "./extract-acevo-setup-ranges";

const RECORDINGS_DIR = "test/artifacts/sessions";
const CSV_PATH = "shared/games/ac-evo/cars.csv";
const V2_HEADER = 16;
const V2_FRAME_HEADER = 5;

/** Walk through the v2 bin file and return the first graphics frame with a non-empty car_model. */
function firstGraphicsFrameWithCar(filePath: string): string | null {
  const data = readFileSync(filePath);
  if (!data.slice(0, 8).equals(Buffer.from("ACCTEST\0", "ascii"))) return null;
  let off = V2_HEADER;
  while (off + V2_FRAME_HEADER <= data.length) {
    const type = data.readUInt8(off);
    const size = data.readUInt32LE(off + 1);
    if (type > 2 || size > 500000 || off + V2_FRAME_HEADER + size > data.length) break;
    if (type === 1 && size >= GRAPHICS_EVO.car_model.offset + 33) {
      const name = readCString(
        data.subarray(off + V2_FRAME_HEADER, off + V2_FRAME_HEADER + size),
        GRAPHICS_EVO.car_model.offset,
        GRAPHICS_EVO.car_model.size!,
      );
      if (name && name.trim().length > 0) return name;
    }
    off += V2_FRAME_HEADER + size;
  }
  return null;
}

/** Append rows to cars.csv, preserving trailing-newline hygiene. */
function appendRows(newRows: string[]): void {
  const content = readFileSync(CSV_PATH, "utf-8");
  const trailingNewline = content.endsWith("\n") ? "" : "\n";
  appendFileSync(CSV_PATH, trailingNewline + newRows.join("\n") + "\n");
  console.log(`\nappended ${newRows.length} row(s) to ${CSV_PATH}`);
}

/** Read system\cars.table from content.kspkg and diff against cars.csv. */
function fromGame(explicitPath: string | undefined): void {
  const kspkgPath = findContentKspkg(explicitPath);
  if (!kspkgPath) {
    console.error("content.kspkg not found — pass a path or set AC_EVO_KSPKG");
    process.exit(1);
  }
  console.log(`reading ${kspkgPath}\n`);

  const pkg = Kspkg.open(kspkgPath);
  let records;
  try {
    records = parseCarsTable(pkg.readFile("system\\cars.table"));
  } finally {
    pkg.close();
  }
  console.log(`game ships ${records.length} car(s)\n`);

  const csv = getAllAcEvoCars();
  const csvModels = new Set(csv.map((c) => c.model.toLowerCase()));
  const csvNames = new Set(csv.map((c) => c.name.toLowerCase()));

  const known: string[] = [];
  const missing: typeof records = [];
  for (const r of records.sort((a, b) => a.slug.localeCompare(b.slug))) {
    // Game slug is "ks_ferrari_296_gt3"; csv model column drops the ks_ prefix.
    const model = r.slug.replace(/^ks_/, "");
    // The table's name field is already the full display name (brand included).
    const display = r.name;
    if (csvModels.has(model.toLowerCase()) || csvNames.has(display.toLowerCase())) {
      known.push(display);
    } else {
      missing.push(r);
    }
  }

  console.log(`== ${known.length} known ==`);
  for (const n of known.sort()) console.log(`  ✓ ${n}`);

  console.log(`\n== ${missing.length} missing from ${CSV_PATH} ==`);
  if (missing.length === 0) {
    console.log(`  ${CSV_PATH} covers every shipped car`);
  } else {
    let nextId = Math.max(0, ...csv.map((c) => c.id)) + 1;
    const newRows: string[] = [];
    for (const r of missing) {
      const model = r.slug.replace(/^ks_/, "");
      // The table's name field is already the full display name (brand included).
      const display = r.name;
      const row = `${nextId},${model},${display},Unknown`;
      console.log(`  ${row}`);
      newRows.push(row);
      nextId++;
    }

    appendRows(newRows);
  }

  console.log("\nrefreshing setup ranges from carsetuplimits…");
  runSetupRangesExtraction(explicitPath);
}

function main(): void {
  if (!process.argv.includes("--recordings")) {
    const next = process.argv[2];
    fromGame(next && !next.startsWith("--") ? next : undefined);
    return;
  }
  if (!existsSync(RECORDINGS_DIR)) {
    console.error(`no recordings dir: ${RECORDINGS_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(RECORDINGS_DIR).filter((f) => f.startsWith("ac-evo-") && f.endsWith(".bin"));
  if (files.length === 0) {
    console.error(`no ac-evo-*.bin recordings`);
    process.exit(1);
  }

  console.log(`scanning ${files.length} recording(s)...\n`);

  const seen = new Map<string, string[]>();
  for (const file of files) {
    const name = firstGraphicsFrameWithCar(join(RECORDINGS_DIR, file));
    if (!name) continue;
    const list = seen.get(name) ?? [];
    list.push(file);
    seen.set(name, list);
  }

  const csvNames = new Set(getAllAcEvoCars().map((c) => c.name.toLowerCase()));
  const known: string[] = [];
  const missing: { name: string; files: string[] }[] = [];
  for (const [name, list] of seen.entries()) {
    if (csvNames.has(name.toLowerCase())) known.push(name);
    else missing.push({ name, files: list });
  }

  console.log(`== ${known.length} known ==`);
  for (const n of known.sort()) console.log(`  ✓ ${n}`);

  console.log(`\n== ${missing.length} missing ==`);
  if (missing.length === 0) {
    console.log("  cars.csv is up to date");
    return;
  }

  let nextId = Math.max(0, ...getAllAcEvoCars().map((c) => c.id)) + 1;
  const newRows: string[] = [];
  for (const m of missing.sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const row = `${nextId},${slug},${m.name},Unknown`;
    console.log(`  ${row}`);
    console.log(`    from: ${m.files.join(", ")}`);
    newRows.push(row);
    nextId++;
  }

  appendRows(newRows);
}

main();
