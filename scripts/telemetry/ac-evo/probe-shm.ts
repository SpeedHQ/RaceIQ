/**
 * Probe AC Evo shared memory pages to find what's available.
 * Run while AC Evo is running.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const kernel32 = dlopen("kernel32", {
  OpenFileMappingW: { args: [FFIType.i32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
  MapViewOfFile: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
});

const FILE_MAP_READ = 0x0004;

const candidates = [
  "Local\\acpmf_physics",
  "Local\\acpmf_graphics",
  "Local\\acpmf_static",
  "Local\\acpmf_spot",
  "Local\\acpmf_cars",
  "Local\\acpmf_timing",
  "Local\\acpmf_lap",
  "Local\\acpmf_replay",
  "Local\\AcEvo_physics",
  "Local\\AcEvo_graphics",
  "Local\\AcEvo_static",
  "Local\\AcEvo_timing",
  "Local\\acpmf_chaser",
  "Local\\acpmf_inputs",
];

// Full graphics dump
const graphicsName = "Local\\acpmf_graphics";
const gNameBuf = Buffer.from(graphicsName + "\0", "utf16le");
const gHandle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ptr(gNameBuf));
if (gHandle && Number(gHandle) !== 0) {
  const viewSize = 1320;
  const view = kernel32.symbols.MapViewOfFile(gHandle, FILE_MAP_READ, 0, 0, viewSize);
  if (view && Number(view) !== 0) {
    const buf = Buffer.from(toArrayBuffer(view as any, 0, viewSize));

    console.log("=== Graphics page — all non-zero i32/f32 fields ===");
    for (let o = 0; o <= viewSize - 4; o += 4) {
      const i = buf.readInt32LE(o);
      const f = buf.readFloatLE(o);
      const fOk = isFinite(f) && Math.abs(f) > 0.001 && Math.abs(f) < 1e9;
      if (i !== 0 || fOk) {
        console.log(`  offset ${String(o).padStart(4)}: i32=${i}  f32=${f.toFixed(4)}`);
      }
    }

    // Also dump key named fields
    console.log("\n=== Named ACC graphics fields ===");
    const fields: [string, number, string][] = [
      ["packetId",            0,   "i32"],
      ["status",              4,   "i32"],
      ["session",             8,   "i32"],
      ["completedLaps",       132, "i32"],
      ["position",            136, "i32"],
      ["iCurrentTime",        140, "i32"],
      ["iLastTime",           144, "i32"],
      ["iBestTime",           148, "i32"],
      ["sessionTimeLeft",     152, "f32"],
      ["distanceTraveled",    156, "f32"],
      ["isInPit",             160, "i32"],
      ["currentSectorIndex",  164, "i32"],
      ["lastSectorTime",      168, "i32"],
      ["numberOfLaps",        172, "i32"],
      ["normalizedCarPos",    248, "f32"],
      ["activeCars",          252, "i32"],
      ["playerCarID",         1216,"i32"],
      ["isInPitLane",         1236,"i32"],
    ];
    for (const [name, offset, type] of fields) {
      const v = type === "i32" ? buf.readInt32LE(offset) : buf.readFloatLE(offset);
      console.log(`  ${name.padEnd(20)} offset=${String(offset).padStart(4)}: ${v}`);
    }

    kernel32.symbols.UnmapViewOfFile(view);
  }
  kernel32.symbols.CloseHandle(gHandle);
}
