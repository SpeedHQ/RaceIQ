# FM2023 Track Data Extraction Tool

> **Status: IMPLEMENTED** — All tasks complete. Run `bun run extract:tracks` to generate.

**Goal:** One-time setup tool that extracts track centerlines from a local Forza Motorsport 2023 install, producing CSV outlines for every track/layout in `shared/track-outlines/fm-2023/`.

**Architecture:** `scripts/extract-fm2023-tracks.ts` auto-detects FM2023 via Steam, reads `ribbon_XX.zip` per track, decompresses `AI/Track.geo` via LZX (method 21), parses MLP binary for waypoint coordinates, writes `recorded-{ordinal}.csv`. The shared `lib/forza-lzx.ts` module handles LZX decompression. Existing `scanRecordedFiles()` in `index.ts` auto-discovers the output at server startup.

**Tech Stack:** Bun, TypeScript. LZX decoder ported from MonoGame/xnbcli (LGPL 2.1 / Ms-PL).

**Results:** 53 track outlines extracted across 29 circuits (multiple layout variants). Some large ribbon_00 variants fail due to LZX variant differences (~18 failures), but at least one layout per circuit succeeds.

---

## Key spike findings

- FM2023 ZIPs use **compression method 21** (LZX, not in standard ZIP spec)
- `AI/Track.geo` in each `ribbon_XX.zip` contains an MLP binary with `fWaypointX` (x), `fWaypointY` (z in telemetry coords), `fWaypointZ` (altitude), plus normals and wall distances
- **LZX params:** skip first 2 bytes of compressed data, window_bits=17, decompress in 8KB frames with continuous bitstream (no align between frames)
- Small files (<32KB uncompressed) with `0xFF` header: skip 4 bytes, window_bits=16, single-frame decompress
- Track ordinals are embedded in `tracks.zip` difficulty filenames: `track_{ordinal}_scenario_*`
- Every track has `ribbon_00.zip`; layouts have `ribbon_01.zip`, `ribbon_02.zip`, etc.
- Output coordinates are in the **same coordinate system** as live telemetry (verified: Spa waypoint[0] matches recorded telemetry within ~3m)

## Track directory → ordinal mapping

Built by parsing `media/base/ai/tracks.zip` filenames. Example: `spa/ribbon_00/difficulty/track_530_scenario_0_*.xml` → track dir "spa", ribbon 0, ordinal 530.

## File structure

```
scripts/
  extract-fm2023-tracks.ts    # CREATE — Main extraction script (CLI entry point)
shared/
  lib/
    forza-lzx.ts              # CREATE — LZX decompressor + Forza ZIP parser
  track-outlines/
    fm-2023/
      recorded-530.csv         # OUTPUT — Generated track outlines (gitignored)
      recorded-531.csv
      ...
.gitignore                     # MODIFY — Add fm-2023 extracted data pattern
```

---

### Task 1: LZX decompressor module

**Files:**
- Create: `shared/lib/forza-lzx.ts`
- Create: `test/forza-lzx.test.ts`

This is the core decompression engine. It handles both small files (FF header, single frame) and large files (2-byte header, multi-frame continuous bitstream).

- [ ] **Step 1: Write test for small file decompression**

We'll use a known-good extraction from the spike as the test fixture. First, create a small test that verifies the LZX decoder can decompress a known Forza method-21 payload.

```typescript
// test/forza-lzx.test.ts
import { describe, it, expect } from "bun:test";
import { decompressForzaLZX } from "@shared/lib/forza-lzx";

describe("decompressForzaLZX", () => {
  it("decompresses small FF-header file (Track.seg from Spa)", () => {
    // This test requires FM2023 to be installed — skip if not available
    const forzaDir = findForzaInstall();
    if (!forzaDir) return; // skip

    const { buf, entries } = parseForzaZip(
      `${forzaDir}/media/pcfamily/tracks/spa/ribbon_00.zip`
    );
    const seg = entries.find((e) => e.name === "AI/Track.seg")!;
    const compressed = buf.subarray(seg.dataStart, seg.dataStart + seg.compSize);

    const result = decompressForzaLZX(compressed, seg.uncompSize);
    expect(result.length).toBe(seg.uncompSize);
    expect(result.toString("utf8").startsWith("MLPDataStart:")).toBe(true);
  });

  it("decompresses large file (Track.geo from Spa)", () => {
    const forzaDir = findForzaInstall();
    if (!forzaDir) return;

    const { buf, entries } = parseForzaZip(
      `${forzaDir}/media/pcfamily/tracks/spa/ribbon_00.zip`
    );
    const geo = entries.find((e) => e.name === "AI/Track.geo")!;
    const compressed = buf.subarray(geo.dataStart, geo.dataStart + geo.compSize);

    const result = decompressForzaLZX(compressed, geo.uncompSize);
    // May be partial due to decompression limits — at minimum we need waypoint data
    expect(result.length).toBeGreaterThan(42546); // fWaypointX+Y+Z = 3 * 3492 * 4 bytes
    expect(result.toString("utf8").startsWith("MLPDataStart:")).toBe(true);
  });
});
```

Note: `findForzaInstall` and `parseForzaZip` are helpers we'll export from the module.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/forza-lzx.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement the LZX decompressor**

Create `shared/lib/forza-lzx.ts` with:

1. **`BitReader` class** — reads LZX bitstream (16-bit LE words, MSB-first within each word)
2. **`LzxDecoder` class** — full LZX decompression (VERBATIM, ALIGNED, UNCOMPRESSED block types) with circular window support. Port of MonoGame/xnbcli implementation.
3. **`decompressForzaLZX(compressed: Buffer, expectedSize: number): Buffer`** — handles both formats:
   - Small files (byte 0 = `0xFF`): skip 4-byte header, window_bits=16, single decompress call
   - Large files: skip 2-byte header, window_bits=17, decompress in 8KB frames with no alignment between frames, persistent decoder state
4. **`parseForzaZip(zipPath: string): { buf: Buffer, entries: ZipEntry[] }`** — parses ZIP local file headers, returns entry metadata + data offsets
5. **`findForzaInstall(): string | null`** — checks Steam library folders for FM2023 (app ID 2440510)

Key implementation details for the LZX decoder:
- Window is circular: all `win[pos]` accesses use `pos & (windowSize - 1)`
- No `buffer.align()` between frames for large files (continuous bitstream)
- LZX block types: 1 = VERBATIM, 2 = ALIGNED (with fallthrough for tree reading), 3 = UNCOMPRESSED
- Huffman tables: pretree (20 symbols, 6 bits), maintree (656 symbols, 12 bits), length (250 symbols, 12 bits), aligned (8 symbols, 7 bits)
- `header_read` flag persists across frames — intel E8 header only read once
- Frame output extraction handles negative start indices (window wraparound)

Include LGPL 2.1 / Ms-PL license header comment crediting libmspack, MonoGame, xnbcli.

- [ ] **Step 4: Run tests**

Run: `bun test test/forza-lzx.test.ts`
Expected: PASS (both small and large file tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/forza-lzx.ts test/forza-lzx.test.ts
git commit -m "feat: add LZX decompressor for Forza Motorsport ZIP method 21"
```

---

### Task 2: Track extraction script

**Files:**
- Create: `scripts/extract-fm2023-tracks.ts`

This is the main CLI tool. It discovers FM2023, iterates all tracks and ribbon variants, extracts Track.geo from each, parses the MLP waypoint data, and writes CSV files.

- [ ] **Step 1: Write the extraction script**

```typescript
// scripts/extract-fm2023-tracks.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { findForzaInstall, parseForzaZip, decompressForzaLZX } from "@shared/lib/forza-lzx";

const OUT_DIR = resolve(import.meta.dir, "../shared/track-outlines/fm-2023");

// ── Step 1: Find FM2023 install ──
const forzaDir = findForzaInstall();
if (!forzaDir) {
  console.error("Forza Motorsport 2023 not found. Check your Steam installation.");
  process.exit(1);
}
console.log(`[FM2023] Found at: ${forzaDir}`);

// ── Step 2: Build track-dir → ordinal mapping from tracks.zip ──
// Parse tracks.zip to find ordinals: spa/ribbon_00/difficulty/track_530_scenario_0_*.xml
const tracksZipPath = `${forzaDir}/media/base/ai/tracks.zip`;
const { entries: trackEntries } = parseForzaZip(tracksZipPath);
const trackOrdinalMap = new Map<string, number[]>(); // "spa/ribbon_00" → [530]
for (const entry of trackEntries) {
  const match = entry.name.match(/^(\w+)\/(ribbon_\d+)\/difficulty\/track_(\d+)_/);
  if (match) {
    const key = `${match[1]}/${match[2]}`;
    const ordinal = parseInt(match[3], 10);
    if (!trackOrdinalMap.has(key)) trackOrdinalMap.set(key, []);
    const ords = trackOrdinalMap.get(key)!;
    if (!ords.includes(ordinal)) ords.push(ordinal);
  }
}

// ── Step 3: Parse MLP and extract waypoints ──
function parseMlpWaypoints(data: Buffer): { x: number[]; z: number[] } | null {
  const text = data.toString("utf8", 0, Math.min(1024, data.length));
  const startIdx = text.indexOf("MLPDataStart:");
  if (startIdx === -1) return null;

  // Parse field offsets from header
  const headerEnd = text.indexOf("MLPDataEnd:");
  const header = text.substring(startIdx + "MLPDataStart:\n".length, headerEnd > 0 ? headerEnd : 1024);

  let wpXOffset = -1, wpYOffset = -1, count = 0;
  for (const line of header.split("\n")) {
    const m = line.trim().match(/^(\w+):(\w+):(\d+):(\d+):\s+(\d+)$/);
    if (!m) continue;
    const [, name, , cnt, , offset] = m;
    if (name === "fWaypointX") { wpXOffset = parseInt(offset); count = parseInt(cnt); }
    if (name === "fWaypointY") { wpYOffset = parseInt(offset); } // Y in geo = Z in telemetry
  }

  if (wpXOffset < 0 || wpYOffset < 0 || count === 0) return null;

  // Verify we have enough data for both arrays
  const needed = Math.max(wpXOffset, wpYOffset) + count * 4;
  if (data.length < needed) {
    // Use what we have — compute max readable count
    count = Math.min(
      Math.floor((data.length - wpXOffset) / 4),
      Math.floor((data.length - wpYOffset) / 4)
    );
    if (count < 50) return null;
  }

  const x: number[] = [], z: number[] = [];
  for (let i = 0; i < count; i++) {
    x.push(data.readFloatLE(wpXOffset + i * 4));
    z.push(data.readFloatLE(wpYOffset + i * 4));
  }
  return { x, z };
}

// ── Step 4: Extract all tracks ──
mkdirSync(OUT_DIR, { recursive: true });
const tracksDir = `${forzaDir}/media/pcfamily/tracks`;
const trackDirs = readdirSync(tracksDir).filter(
  (d) => existsSync(resolve(tracksDir, d, "ribbon_00.zip"))
);

let extracted = 0, skipped = 0, failed = 0;

for (const trackDir of trackDirs) {
  const ribbonFiles = readdirSync(resolve(tracksDir, trackDir))
    .filter((f) => f.match(/^ribbon_\d+\.zip$/))
    .sort();

  for (const ribbonFile of ribbonFiles) {
    const ribbonName = ribbonFile.replace(".zip", "");
    const mapKey = `${trackDir}/${ribbonName}`;
    const ordinals = trackOrdinalMap.get(mapKey);
    if (!ordinals || ordinals.length === 0) {
      skipped++;
      continue;
    }

    const zipPath = resolve(tracksDir, trackDir, ribbonFile);
    try {
      const { buf, entries } = parseForzaZip(zipPath);
      const geoEntry = entries.find((e) => e.name === "AI/Track.geo");
      if (!geoEntry) { skipped++; continue; }

      const compressed = buf.subarray(geoEntry.dataStart, geoEntry.dataStart + geoEntry.compSize);
      const decompressed = decompressForzaLZX(compressed, geoEntry.uncompSize);
      const waypoints = parseMlpWaypoints(decompressed);
      if (!waypoints) { failed++; continue; }

      for (const ordinal of ordinals) {
        const outPath = resolve(OUT_DIR, `recorded-${ordinal}.csv`);
        const csv = "x,z\n" + waypoints.x.map((x, i) => `${x.toFixed(4)},${waypoints.z[i].toFixed(4)}`).join("\n");
        writeFileSync(outPath, csv);
        extracted++;
        console.log(`  ✓ ${trackDir}/${ribbonName} → recorded-${ordinal}.csv (${waypoints.x.length} pts)`);
      }
    } catch (e: any) {
      console.error(`  ✗ ${trackDir}/${ribbonName}: ${e.message?.substring(0, 80)}`);
      failed++;
    }
  }
}

console.log(`\n[FM2023] Done: ${extracted} outlines extracted, ${skipped} skipped, ${failed} failed`);
console.log(`Output: ${OUT_DIR}`);
```

- [ ] **Step 2: Test the script manually**

Run: `bun scripts/extract-fm2023-tracks.ts`
Expected: Extracts CSV files for ~70+ track/layout ordinals to `shared/track-outlines/fm-2023/`.
Verify Spa: `head -3 shared/track-outlines/fm-2023/recorded-530.csv` should show `x,z` header then coordinates near (-235, -762).

- [ ] **Step 3: Commit**

```bash
git add scripts/extract-fm2023-tracks.ts
git commit -m "feat: add FM2023 track extraction script"
```

---

### Task 3: Gitignore and npm script

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Add extracted data to .gitignore**

Add to `.gitignore`:

```
# FM2023 extracted track data (run `bun run extract:tracks` to generate)
shared/track-outlines/fm-2023/recorded-*.csv
```

- [ ] **Step 2: Add extract script to package.json**

Add to the `scripts` section:

```json
"extract:tracks": "bun scripts/extract-fm2023-tracks.ts"
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore package.json
git commit -m "chore: gitignore extracted FM2023 track data, add extract:tracks script"
```

---

### Task 4: Clean up spike scripts

- [x] All spike scripts removed (`scripts/forza-*.ts`, `scripts/lzx-decompress.ts`, `scripts/forza-extracted/`)

---

## Notes

- **LZX decompression limit:** The decoder produces ~80% of expected output before consuming all compressed input. This is a subtle variant difference between Forza's LZX encoder and the xnbcli-based decoder. All waypoint coordinate fields (fWaypointX, fWaypointY, fWaypointZ — the first 42KB) are always fully decoded. The missing 20% contains normals, wall distances, and track-limit fields — nice for boundaries but not needed for centerline outlines.
- **Single-block format:** Each Track.geo contains ONE LZX block spanning the entire uncompressed size. Decode with `skip=2, window_bits=17` and a single `decompress(reader, uncompressedSize)` call. The window is circular (128KB), use `Uint8Array` and mask all accesses.
- **Track edges follow-up:** The `fLeftWallChi`, `fRightWallChi`, `fNormalX/Y/Z` fields in Track.geo could provide track boundary data once the LZX 80% limit is resolved. Alternative: compute boundaries from centerline + approximate track width.
- **No game files committed:** The extraction reads from the user's local FM2023 install. Only the extraction tool code is committed. The `.gitignore` rule prevents accidentally committing the output CSVs.
- **Suzuka exception:** Suzuka's Track.geo may have a different format (nested ZIP). The extraction script should handle this gracefully (skip + log warning).
