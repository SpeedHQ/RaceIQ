/**
 * Extract unique AC Evo car display names from `.bin` recordings in
 * test/artifacts/laps and diff against cars.csv.
 *
 * Reads SPageFileGraphicEvo.car_model (char[33] at offset 3086) from each
 * recording's first populated graphics frame — that's the authoritative
 * display name the game wrote to shared memory while you were driving.
 *
 * Usage:
 *   bun run scripts/extract-ac-evo-cars.ts          # dry run
 *   bun run scripts/extract-ac-evo-cars.ts --write  # append new rows to cars.csv
 */
import { readFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { GRAPHICS_EVO } from "../server/games/ac-evo/structs";
import { readCString } from "../server/games/ac-evo/utils";
import { getAllAcEvoCars, getAcEvoCarByDisplayName } from "../shared/ac-evo-car-data";

const RECORDINGS_DIR = "test/artifacts/laps";
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

function main(): void {
  const write = process.argv.includes("--write");
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

  if (write) {
    const content = readFileSync(CSV_PATH, "utf-8");
    const trailingNewline = content.endsWith("\n") ? "" : "\n";
    appendFileSync(CSV_PATH, trailingNewline + newRows.join("\n") + "\n");
    console.log(`\nappended ${newRows.length} row(s) to ${CSV_PATH}`);
  } else {
    console.log(`\n(dry run — rerun with --write to append to ${CSV_PATH})`);
  }
}

main();
