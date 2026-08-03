/**
 * Extract unique AC Evo track identity strings from `.bin` recordings in
 * test/artifacts/sessions and diff against tracks.csv.
 *
 * Reads SPageFileStaticEvo.track (char[33] at offset 136),
 * .track_configuration (char[33] at offset 169) and .track_length_m from
 * each recording's first populated static frame — the authoritative track
 * identity the game wrote to shared memory while you were driving.
 *
 * Usage:
 *   bun run scripts/extract-ac-evo-tracks.ts [kspkg]        # read track list from content.kspkg, append new rows
 *   bun run scripts/extract-ac-evo-tracks.ts --recordings   # scan .bin recordings, report known/unknown tracks
 *
 * Default mode reads system\tracks.table out of the game's content.kspkg
 * (auto-located via AC_EVO_KSPKG or common Steam paths), diffs the full
 * shipped track list against tracks.csv and appends any missing rows —
 * run it after any game update to pick up every new track, no driving
 * required. Appended rows default to variant "GP"; extra layouts still
 * need one drive each (the table has no layout list).
 */
import { readFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { gunzipSync } from "zlib";
import { join } from "path";
import { STATIC_EVO } from "../server/games/ac-evo/structs";
import { readCString } from "../server/games/ac-evo/utils";
import { getAcEvoTrackByName, getAcEvoTracks } from "../shared/racing/tracks/catalogs/ac-evo"
import { Kspkg, findContentKspkg } from "../server/games/ac-evo/kspkg";
import { parseTracksTable } from "../server/games/ac-evo/kspkg-tables";
import { extractAcEvoTrackGeometry } from "./extract-ac-evo-tracks-geometry";

const RECORDINGS_DIR = "test/artifacts/sessions";
const CSV_PATH = "shared/games/ac-evo/tracks.csv";
const V2_HEADER = 16;
const V2_FRAME_HEADER = 5;
const STATIC_FRAME_TYPE = 2; // 0 = physics, 1 = graphics, 2 = static

interface TrackIdentity {
  track: string;
  config: string;
  lengthM: number;
}

/** Walk the v2 bin file and return the first static frame with a non-empty track. */
function firstStaticFrameWithTrack(filePath: string): TrackIdentity | null {
  let data = readFileSync(filePath);
  if (filePath.endsWith(".gz")) data = gunzipSync(data);
  if (!data.slice(0, 8).equals(Buffer.from("ACCTEST\0", "ascii"))) return null;
  let off = V2_HEADER;
  while (off + V2_FRAME_HEADER <= data.length) {
    const type = data.readUInt8(off);
    const size = data.readUInt32LE(off + 1);
    if (type > 2 || size > 500000 || off + V2_FRAME_HEADER + size > data.length) break;
    if (type === STATIC_FRAME_TYPE && size >= STATIC_EVO.track_length_m.offset + 4) {
      const buf = data.subarray(off + V2_FRAME_HEADER, off + V2_FRAME_HEADER + size);
      const track = readCString(buf, STATIC_EVO.track.offset, STATIC_EVO.track.size);
      if (track && track.trim().length > 0) {
        return {
          track: track.trim(),
          config: readCString(buf, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size).trim(),
          lengthM: buf.readFloatLE(STATIC_EVO.track_length_m.offset),
        };
      }
    }
    off += V2_FRAME_HEADER + size;
  }
  return null;
}

/** Read system\tracks.table from content.kspkg and diff against tracks.csv. */
function fromGame(explicitPath?: string): void {
  const kspkgPath = findContentKspkg(explicitPath);
  if (!kspkgPath) {
    console.error("content.kspkg not found — pass a path or set AC_EVO_KSPKG");
    process.exit(1);
  }
  console.log(`reading ${kspkgPath}\n`);

  const pkg = Kspkg.open(kspkgPath);
  let records;
  try {
    records = parseTracksTable(pkg.readFile("system\\tracks.table"));
  } finally {
    pkg.close();
  }
  // "interns" scenes (Garage, Startup, Paintshop, ...) are menu backdrops, not tracks.
  const tracks = records.filter((r) => r.folder !== "interns");
  console.log(`game ships ${tracks.length} track(s) (${records.length - tracks.length} interns scene(s) skipped)\n`);

  const known: string[] = [];
  const missing: typeof tracks = [];
  for (const t of tracks.sort((a, b) => a.name.localeCompare(b.name))) {
    if (getAcEvoTrackByName(t.name)) known.push(t.name);
    else missing.push(t);
  }

  console.log(`== ${known.length} known ==`);
  for (const n of known) console.log(`  ✓ ${n}`);

  console.log(`\n== ${missing.length} missing from ${CSV_PATH} ==`);
  if (missing.length === 0) {
    console.log(`  ${CSV_PATH} covers every shipped track`);
    return;
  }
  let nextId = Math.max(0, ...[...getAcEvoTracks().values()].map((t) => t.id)) + 1;
  const newRows: string[] = [];
  for (const t of missing) {
    const where = [t.country, t.region].filter(Boolean).join(", ");
    const slug = t.folder.toLowerCase().replace(/_/g, "-");
    const row = `${nextId},${t.name},GP,${slug}`;
    console.log(`  ✗ ${t.name} (folder=${t.folder}${where ? `, ${where}` : ""})`);
    console.log(`    ${row}`);
    newRows.push(row);
    nextId++;
  }

  const content = readFileSync(CSV_PATH, "utf-8");
  const trailingNewline = content.endsWith("\n") ? "" : "\n";
  appendFileSync(CSV_PATH, trailingNewline + newRows.join("\n") + "\n");
  console.log(
    `\nappended ${newRows.length} row(s) to ${CSV_PATH} (variant defaults to GP — extra layouts still need one drive each; the table has no layout list)`,
  );
}

async function main(): Promise<void> {
  if (!process.argv.includes("--recordings")) {
    const next = process.argv[2];
    fromGame(next && !next.startsWith("--") ? next : undefined);
    // After reconciling the track roster, extract native track geometry
    // (centerlines + boundaries + meta) from content.kspkg for every AC Evo
    // layout that ships one. Skip with --no-geometry (identity diff only).
    if (!process.argv.includes("--no-geometry")) {
      console.log("\n── extracting track geometry ──");
      await extractAcEvoTrackGeometry();
    }
    return;
  }
  if (!existsSync(RECORDINGS_DIR)) {
    console.error(`no recordings dir: ${RECORDINGS_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(RECORDINGS_DIR).filter(
    (f) => /(^|^session-)ac-evo-/.test(f) && (f.endsWith(".bin") || f.endsWith(".bin.gz")),
  );
  if (files.length === 0) {
    console.error(`no ac-evo-*.bin recordings`);
    process.exit(1);
  }

  console.log(`scanning ${files.length} recording(s)...\n`);

  const seen = new Map<string, { id: TrackIdentity; files: string[] }>();
  for (const file of files) {
    const id = firstStaticFrameWithTrack(join(RECORDINGS_DIR, file));
    if (!id) continue;
    const key = `${id.track}|${id.config}`;
    const entry = seen.get(key) ?? { id, files: [] };
    entry.files.push(file);
    seen.set(key, entry);
  }

  if (seen.size === 0) {
    console.log("no static frames with track data found");
    return;
  }

  const csvTracks = getAcEvoTracks();
  console.log(`tracks.csv currently has ${csvTracks.size} row(s)\n`);

  for (const { id, files: list } of [...seen.values()].sort((a, b) => a.id.track.localeCompare(b.id.track))) {
    const resolved = getAcEvoTrackByName(id.track);
    const km = (id.lengthM / 1000).toFixed(2);
    console.log(`track="${id.track}" config="${id.config}" length=${km} km`);
    if (resolved) {
      console.log(`  → resolves to id ${resolved.id}: ${resolved.name} - ${resolved.variant} (${resolved.commonTrackName})`);
      // A configured layout that resolves onto a differently-named base row is
      // exactly the Brands Hatch Indy → GP collision; flag it loudly.
      if (id.config && !resolved.variant.toLowerCase().includes(id.config.toLowerCase())) {
        console.log(`  ⚠ config "${id.config}" does not match resolved variant "${resolved.variant}" — likely missing a layout row in ${CSV_PATH}`);
      }
    } else {
      console.log(`  ✗ UNKNOWN — not in ${CSV_PATH}`);
    }
    console.log(`  from: ${list.join(", ")}`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
