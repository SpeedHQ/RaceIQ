/**
 * Diagnostic: read AC Evo v2 lap recording and dump PHYSICS struct values
 * at frame ~12000 using ACC struct offsets.
 *
 * Format v2: 16-byte header, then frames of [type:u8][size:u32LE][data:size bytes]
 * type=0 → physics (800 bytes)
 */

import { readFileSync } from "fs";

const PHYSICS_SIZE = 800;
const HEADER_SIZE = 16;

const FIELDS: Record<string, { offset: number; type: "f32" | "i32" }> = {
  packetId:       { offset: 0,   type: "i32" },
  gas:            { offset: 4,   type: "f32" },
  brake:          { offset: 8,   type: "f32" },
  fuel:           { offset: 12,  type: "f32" },
  gear:           { offset: 16,  type: "i32" },
  rpms:           { offset: 20,  type: "i32" },
  steerAngle:     { offset: 24,  type: "f32" },
  speedKmh:       { offset: 28,  type: "f32" },
  velocityX:      { offset: 32,  type: "f32" },
  velocityY:      { offset: 36,  type: "f32" },
  velocityZ:      { offset: 40,  type: "f32" },
  accGX:          { offset: 44,  type: "f32" },
  accGY:          { offset: 48,  type: "f32" },
  accGZ:          { offset: 52,  type: "f32" },
  wheelSlipFL:    { offset: 56,  type: "f32" },
  wheelSlipFR:    { offset: 60,  type: "f32" },
  wheelSlipRL:    { offset: 64,  type: "f32" },
  wheelSlipRR:    { offset: 68,  type: "f32" },
  tyrePressureFL: { offset: 88,  type: "f32" },
  tyrePressureFR: { offset: 92,  type: "f32" },
  tyrePressureRL: { offset: 96,  type: "f32" },
  tyrePressureRR: { offset: 100, type: "f32" },
  wheelRotFL:     { offset: 104, type: "f32" },
  wheelRotFR:     { offset: 108, type: "f32" },
  wheelRotRL:     { offset: 112, type: "f32" },
  wheelRotRR:     { offset: 116, type: "f32" },
  tyreWearFL:     { offset: 120, type: "f32" },
  tyreWearFR:     { offset: 124, type: "f32" },
  tyreWearRL:     { offset: 128, type: "f32" },
  tyreWearRR:     { offset: 132, type: "f32" },
  tyreCoreFL:     { offset: 152, type: "f32" },
  tyreCoreFR:     { offset: 156, type: "f32" },
  tyreCoreRL:     { offset: 160, type: "f32" },
  tyreCoreRR:     { offset: 164, type: "f32" },
  camberFL:       { offset: 168, type: "f32" },
  camberFR:       { offset: 172, type: "f32" },
  camberRL:       { offset: 176, type: "f32" },
  camberRR:       { offset: 180, type: "f32" },
  suspTravelFL:   { offset: 184, type: "f32" },
  suspTravelFR:   { offset: 188, type: "f32" },
  suspTravelRL:   { offset: 192, type: "f32" },
  suspTravelRR:   { offset: 196, type: "f32" },
  tc:             { offset: 204, type: "f32" },
  heading:        { offset: 208, type: "f32" },
  pitch:          { offset: 212, type: "f32" },
  roll:           { offset: 216, type: "f32" },
  damFront:       { offset: 224, type: "f32" },
  damRear:        { offset: 228, type: "f32" },
  damLeft:        { offset: 232, type: "f32" },
  damRight:       { offset: 236, type: "f32" },
  damCentre:      { offset: 240, type: "f32" },
  abs:            { offset: 252, type: "f32" },
  airTemp:        { offset: 288, type: "f32" },
  roadTemp:       { offset: 292, type: "f32" },
  localAngularVelX: { offset: 296, type: "f32" },
  localAngularVelY: { offset: 300, type: "f32" },
  localAngularVelZ: { offset: 304, type: "f32" },
  brakeTempFL:    { offset: 348, type: "f32" },
  brakeTempFR:    { offset: 352, type: "f32" },
  brakeTempRL:    { offset: 356, type: "f32" },
  brakeTempRR:    { offset: 360, type: "f32" },
  clutch:         { offset: 364, type: "f32" },
  tyreTempInnerFL: { offset: 368, type: "f32" },
  tyreTempInnerFR: { offset: 372, type: "f32" },
  tyreTempInnerRL: { offset: 376, type: "f32" },
  tyreTempInnerRR: { offset: 380, type: "f32" },
  tyreTempMiddleFL: { offset: 384, type: "f32" },
  tyreTempMiddleFR: { offset: 388, type: "f32" },
  tyreTempMiddleRL: { offset: 392, type: "f32" },
  tyreTempMiddleRR: { offset: 396, type: "f32" },
  tyreTempOuterFL: { offset: 400, type: "f32" },
  tyreTempOuterFR: { offset: 404, type: "f32" },
  tyreTempOuterRL: { offset: 408, type: "f32" },
  tyreTempOuterRR: { offset: 412, type: "f32" },
  brakeBias:      { offset: 564, type: "f32" },
  localVelocityX: { offset: 568, type: "f32" },
  localVelocityY: { offset: 572, type: "f32" },
  localVelocityZ: { offset: 576, type: "f32" },
  currentMaxRpm:  { offset: 588, type: "i32" },
  slipRatioFL:    { offset: 640, type: "f32" },
  slipRatioFR:    { offset: 644, type: "f32" },
  slipRatioRL:    { offset: 648, type: "f32" },
  slipRatioRR:    { offset: 652, type: "f32" },
  slipAngleFL:    { offset: 656, type: "f32" },
  slipAngleFR:    { offset: 660, type: "f32" },
  slipAngleRL:    { offset: 664, type: "f32" },
  slipAngleRR:    { offset: 668, type: "f32" },
  tyreTempFL:     { offset: 696, type: "f32" },
  tyreTempFR:     { offset: 700, type: "f32" },
  tyreTempRL:     { offset: 704, type: "f32" },
  tyreTempRR:     { offset: 708, type: "f32" },
  waterTemp:      { offset: 712, type: "f32" },
  padLifeFL:      { offset: 740, type: "f32" },
  padLifeFR:      { offset: 744, type: "f32" },
  padLifeRL:      { offset: 748, type: "f32" },
  padLifeRR:      { offset: 752, type: "f32" },
  discLifeFL:     { offset: 756, type: "f32" },
  discLifeFR:     { offset: 760, type: "f32" },
  discLifeRL:     { offset: 764, type: "f32" },
  discLifeRR:     { offset: 768, type: "f32" },
  kerbVibration:  { offset: 784, type: "f32" },
  slipVibrations: { offset: 788, type: "f32" },
  gVibrations:    { offset: 792, type: "f32" },
  absVibrations:  { offset: 796, type: "f32" },
};

const BIN_PATH = "C:/Users/acoop/Documents/GitHub/RaceIQ/test/artifacts/laps/ac-evo-2026-04-14T13-22-58-048Z.bin";

const buf = readFileSync(BIN_PATH);
console.log(`File size: ${buf.length} bytes`);

// Parse header (16 bytes)
// Bytes 0-3: magic/version, 4-7: game, 8-11: count or something, 12-15: ?
const magic = buf.readUInt32LE(0);
const version = buf.readUInt32LE(4);
const frameCount = buf.readUInt32LE(8);
const reserved = buf.readUInt32LE(12);
console.log(`Header: magic=0x${magic.toString(16)} version=${version} frameCount=${frameCount} reserved=${reserved}`);

// Parse all frames, collect physics (type=0) frames
interface Frame {
  type: number;
  data: Buffer;
}

const physicsFrames: Buffer[] = [];
let pos = HEADER_SIZE;
let totalFrames = 0;

while (pos < buf.length) {
  if (pos + 5 > buf.length) break;
  const type = buf[pos];
  const size = buf.readUInt32LE(pos + 1);
  pos += 5;
  if (pos + size > buf.length) break;
  const data = buf.slice(pos, pos + size);
  pos += size;
  totalFrames++;
  if (type === 0) {
    physicsFrames.push(data);
  }
}

console.log(`Total frames parsed: ${totalFrames}, physics frames: ${physicsFrames.length}`);

// Pick frame ~12000 (or nearest available)
const targetIdx = Math.min(12000, physicsFrames.length - 1);
const frame = physicsFrames[targetIdx];
console.log(`\nUsing physics frame index: ${targetIdx} (data size: ${frame.length} bytes)`);

if (frame.length < PHYSICS_SIZE) {
  console.warn(`WARNING: frame size ${frame.length} < expected ${PHYSICS_SIZE}`);
}

const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

function readField(offset: number, type: "f32" | "i32"): number {
  if (offset + 4 > frame.length) return NaN;
  if (type === "f32") return view.getFloat32(offset, true);
  return view.getInt32(offset, true);
}

console.log("\n=== PHYSICS FIELD VALUES AT FRAME " + targetIdx + " ===");
console.log("Field                    Offset  Type   Value");
console.log("─".repeat(60));

const KEY_FIELDS = new Set([
  "gas","brake","steerAngle","speedKmh","rpms","gear","fuel",
  "heading","pitch","roll",
  "tyreTempFL","tyreTempFR","tyreTempRL","tyreTempRR",
  "tyreCoreFL","tyreCoreFR","tyreCoreRL","tyreCoreRR",
  "tyrePressureFL","tyrePressureFR","tyrePressureRL","tyrePressureRR",
  "tc","abs","brakeBias","waterTemp","currentMaxRpm",
  "suspTravelFL","suspTravelFR","suspTravelRL","suspTravelRR",
]);

for (const [name, { offset, type }] of Object.entries(FIELDS)) {
  const val = readField(offset, type);
  const star = KEY_FIELDS.has(name) ? " ★" : "";
  console.log(`${name.padEnd(24)} ${String(offset).padStart(5)}  ${type}  ${val.toFixed(4)}${star}`);
}

// Scan all f32 offsets 0..796 step 4, check which are always-zero across ALL physics frames
console.log("\n=== ALWAYS-ZERO SCAN (all physics frames) ===");
// Collect all frame DataViews
const allViews = physicsFrames.map(f => new DataView(f.buffer, f.byteOffset, f.byteLength));

const alwaysZero: number[] = [];
const hasData: number[] = [];

for (let off = 0; off <= 796; off += 4) {
  let allZero = true;
  let anyNonZero = false;
  for (const dv of allViews) {
    if (off + 4 > dv.byteLength) continue;
    const v = dv.getFloat32(off, true);
    if (v !== 0.0 && !isNaN(v) && isFinite(v)) {
      anyNonZero = true;
      allZero = false;
      break;
    }
  }
  if (allZero) alwaysZero.push(off);
  else hasData.push(off);
}

console.log(`Offsets (f32) always zero across all frames: ${alwaysZero.length}`);
console.log("Always-zero offsets:", alwaysZero.join(", "));

// Map always-zero offsets back to named fields
const namedAlwaysZero: string[] = [];
const namedAlwaysZeroSet = new Set(alwaysZero);
for (const [name, { offset, type }] of Object.entries(FIELDS)) {
  if (type === "f32" && namedAlwaysZeroSet.has(offset)) {
    namedAlwaysZero.push(`${name} (offset ${offset})`);
  }
}
console.log("\nNamed PHYSICS fields that are always zero:");
for (const f of namedAlwaysZero) console.log("  ", f);

// Sanity check summary
console.log("\n=== SANITY CHECK SUMMARY ===");
const f = physicsFrames[targetIdx];
const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
const checks: [string, number, string, boolean][] = [
  ["gas",            dv.getFloat32(4, true),   "0–1",        (v => v >= 0 && v <= 1)(dv.getFloat32(4, true))],
  ["brake",          dv.getFloat32(8, true),   "0–1",        (v => v >= 0 && v <= 1)(dv.getFloat32(8, true))],
  ["steerAngle",     dv.getFloat32(24, true),  "-1–1",       (v => v >= -1 && v <= 1)(dv.getFloat32(24, true))],
  ["speedKmh",       dv.getFloat32(28, true),  "50–350",     (v => v >= 50 && v <= 350)(dv.getFloat32(28, true))],
  ["rpms",           dv.getInt32(20, true),    "3000–12000", (v => v >= 3000 && v <= 12000)(dv.getInt32(20, true))],
  ["gear",           dv.getInt32(16, true),    "2–8",        (v => v >= 2 && v <= 8)(dv.getInt32(16, true))],
  ["fuel",           dv.getFloat32(12, true),  "5–80",       (v => v >= 5 && v <= 80)(dv.getFloat32(12, true))],
  ["waterTemp",      dv.getFloat32(712, true), "60–120",     (v => v >= 60 && v <= 120)(dv.getFloat32(712, true))],
  ["tyreTempFL",     dv.getFloat32(696, true), "30–150",     (v => v >= 30 && v <= 150)(dv.getFloat32(696, true))],
  ["tyrePressureFL", dv.getFloat32(88, true),  "20–45",      (v => v >= 20 && v <= 45)(dv.getFloat32(88, true))],
  ["brakeBias",      dv.getFloat32(564, true), "0.45–0.75",  (v => v >= 0.45 && v <= 0.75)(dv.getFloat32(564, true))],
  ["currentMaxRpm",  dv.getInt32(588, true),   "6000–12000", (v => v >= 6000 && v <= 12000)(dv.getInt32(588, true))],
];
for (const [name, val, range, ok] of checks) {
  console.log(`  ${ok ? "OK" : "FAIL"} ${name.padEnd(20)} = ${typeof val === "number" ? val.toFixed(2) : val}  (expected ${range})`);
}
