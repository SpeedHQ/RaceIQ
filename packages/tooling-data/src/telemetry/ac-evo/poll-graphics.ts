/**
 * Live poll AC Evo graphics shared memory — run while driving to see if
 * completedLaps / iCurrentTime / normalizedCarPosition ever populate.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const k32 = dlopen("kernel32", {
  OpenFileMappingW: { args: [FFIType.i32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
  MapViewOfFile: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
});

const FILE_MAP_READ = 0x0004;
const nameBuf = Buffer.from("Local\\acpmf_graphics\0", "utf16le");
const handle = k32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ptr(nameBuf));

if (!handle || Number(handle) === 0) {
  console.error("Could not open acpmf_graphics — is AC Evo running?");
  process.exit(1);
}

const view = k32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 1320);
if (!view || Number(view) === 0) {
  console.error("Could not map view");
  process.exit(1);
}

console.log("Polling AC Evo graphics page every 500ms — drive a timed lap...\n");

let prevLaps = -1;
let prevCur = -1;
let prevLast = -1;

const interval = setInterval(() => {
  const buf = Buffer.from(toArrayBuffer(view as any, 0, 1320));

  const packetId   = buf.readInt32LE(0);
  const status     = buf.readInt32LE(4);
  const laps       = buf.readInt32LE(132);
  const cur        = buf.readInt32LE(140);
  const last       = buf.readInt32LE(144);
  const best       = buf.readInt32LE(148);
  const norm       = buf.readFloatLE(248);
  const dist       = buf.readFloatLE(156);
  const activeCars = buf.readInt32LE(252);

  const changed = laps !== prevLaps || cur !== prevCur || last !== prevLast;

  // Always print so user can see it's working
  const time = new Date().toISOString().slice(11, 19);
  console.log(
    `${time} | pkt=${packetId} status=${status} activeCars=${activeCars}` +
    ` | laps=${laps} cur=${cur}ms last=${last}ms best=${best}ms` +
    ` | norm=${norm.toFixed(4)} dist=${dist.toFixed(0)}m` +
    (changed ? " ← CHANGED" : "")
  );

  prevLaps = laps;
  prevCur = cur;
  prevLast = last;
}, 500);

setTimeout(() => {
  clearInterval(interval);
  k32.symbols.UnmapViewOfFile(view);
  k32.symbols.CloseHandle(handle);
  console.log("\nDone.");
  process.exit(0);
}, 90000);
