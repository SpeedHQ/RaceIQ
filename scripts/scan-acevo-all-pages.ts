/**
 * Scan all AC Evo shared memory pages for ANY changing fields.
 * Uses RtlCopyMemory like the production reader.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const k32 = dlopen("kernel32", {
  OpenFileMappingW: { args: [FFIType.i32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
  MapViewOfFile:    { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  RtlCopyMemory:    { args: [FFIType.ptr, FFIType.ptr, FFIType.usize], returns: FFIType.void },
  CloseHandle:      { args: [FFIType.ptr], returns: FFIType.bool },
});

const FILE_MAP_READ = 0x0004;

const pageSpecs = [
  { name: "Local\\acpmf_physics",  size: 800  },
  { name: "Local\\acpmf_graphics", size: 1320 },
  { name: "Local\\acpmf_static",   size: 688  },
];

// Open all pages
const handles = pageSpecs.map(p => {
  const nameBuf = Buffer.from(p.name + "\0", "utf16le");
  const handle = k32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ptr(nameBuf));
  if (!handle || Number(handle) === 0) { console.log(`Not found: ${p.name}`); return null; }
  const view = k32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, p.size);
  if (!view || Number(view) === 0) { console.log(`Could not map: ${p.name}`); return null; }
  const dest = Buffer.alloc(p.size);
  console.log(`Opened: ${p.name}`);
  return { view, dest, destPtr: ptr(dest) };
});

function snapshot(): Buffer[] {
  return handles.map((h, i) => {
    if (!h) return Buffer.alloc(pageSpecs[i].size);
    k32.symbols.RtlCopyMemory(h.destPtr, h.view, pageSpecs[i].size);
    return Buffer.from(h.dest); // copy
  });
}

// Collect 10 snapshots over 20 seconds
console.log("\nDrive while sampling — 10 samples over 20 seconds...\n");
const SAMPLES = 10;
const snaps: Buffer[][] = [];

for (let i = 0; i < SAMPLES; i++) {
  snaps.push(snapshot());
  process.stdout.write(`  sample ${i+1}/${SAMPLES}: physics[0]=${snaps[i][0].readInt32LE(0)} graphics[0]=${snaps[i][1].readInt32LE(0)}\n`);
  if (i < SAMPLES - 1) await new Promise(r => setTimeout(r, 2000));
}

console.log("\n=== Fields that changed ===\n");

for (let pi = 0; pi < pageSpecs.length; pi++) {
  const pageName = pageSpecs[pi].name.split("\\")[1];
  const size = pageSpecs[pi].size;
  console.log(`--- ${pageName} ---`);
  let found = 0;

  for (let o = 0; o <= size - 4; o += 4) {
    const ivals = snaps.map(s => s[pi].readInt32LE(o));
    const fvals = snaps.map(s => s[pi].readFloatLE(o));
    if (ivals.every(v => v === ivals[0])) continue;

    found++;
    const imin = Math.min(...ivals), imax = Math.max(...ivals);
    const fvalid = fvals.every(isFinite);
    const fmin = fvalid ? Math.min(...fvals) : 0;
    const fmax = fvalid ? Math.max(...fvals) : 0;

    const notes: string[] = [];
    if (fvalid && fmin >= 0 && fmax <= 1.05) notes.push("NORM_POS?");
    if (imax > 10000 && imax < 300000 && imax > imin) notes.push("TIMER_MS?");
    if (imax <= 20 && imin >= 0) notes.push("LAP_COUNT?");
    if (fvalid && fmin >= 0 && fmax < 100000 && fmax > fmin + 50) notes.push("DISTANCE?");

    console.log(`  offset ${String(o).padStart(4)}: i32 [${ivals.join(",")}]  f32 [${fvals.map(f=>f.toFixed(3)).join(",")}]  ${notes.join(" ")}`);
  }

  if (found === 0) console.log("  (nothing changed)");
  console.log();
}
