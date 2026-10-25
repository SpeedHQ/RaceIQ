import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump-decoder";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const source = resolve(fixtures, "laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin");
const output = resolve(fixtures, "sessions/lmu-real-opponents-2026-10-22.bin.gz");
const firstFrame = 14_500;
const lastFrame = 30_956;
const frameStride = 50;
const file = openSync(source, "r");
const sourceHash = createHash("sha256");
const selectedHash = createHash("sha256");
const sourceSize = statSync(source).size;
const header = Buffer.alloc(16);
readSync(file, header, 0, header.length, 0);
if (!header.subarray(0, 8).equals(Buffer.from("LMUQDMP\0")) || header.readUInt32LE(8) !== 1) throw new Error("Unexpected LMU dump header");
sourceHash.update(header);
const frameCount = header.readUInt32LE(12);
const encoder = new SparseCaptureEncoder("lmu");
const outputParts = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
let offset = outputParts.reduce((n, part) => n + part.length, 0);
const gridOutput = resolve(fixtures, "sessions/lmu-real-opponents-grid-2026-10-22.bin.gz");
const gridEncoder = new SparseCaptureEncoder("lmu");
const gridParts = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
const gridHash = createHash("sha256");
const gridNames = new Set<string>();
let gridOffset = gridParts.reduce((n, part) => n + part.length, 0);
let gridFrames = 0;
let sourceOffset = header.length;
let previousSequence: bigint | null = null;
let sequenceGaps = 0;
let selectedFrames = 0;
let firstSequence: string | null = null;
const timestamps: number[] = [];
const names = new Set<string>();
for (let index = 0; index < frameCount; index++) {
  const prefix = Buffer.alloc(5);
  if (readSync(file, prefix, 0, prefix.length, sourceOffset) !== prefix.length || prefix[0] !== 0) throw new Error(`Invalid source record at ${index}`);
  const length = prefix.readUInt32LE(1);
  const record = Buffer.alloc(length);
  if (readSync(file, record, 0, length, sourceOffset + prefix.length) !== length) throw new Error(`Truncated source record at ${index}`);
  sourceHash.update(prefix).update(record);
  if (index <= 100 && index % 2 === 0) {
    const singleHeader = Buffer.from(header);
    singleHeader.writeUInt32LE(1, 12);
    const frame = readLMUFramesFromBuffer(Buffer.concat([singleHeader, prefix, record]), 1)[0];
    const decoded = frame && decodeLMUSourceFrame(frame);
    if (!frame || !decoded?.lmuContext || decoded.schemaVersion !== 3) throw new Error(`Invalid grid source frame ${index}`);
    gridHash.update(frame);
    gridFrames++;
    for (const competitor of decoded.lmuContext.competitors ?? []) {
      const name = competitor.channels["identity.competitor.driver-name"]?.value;
      if (!competitor.isPlayer && typeof name === "string") gridNames.add(name);
    }
    const sparse = gridEncoder.encode(frame, gridOffset);
    const timestamp = encodeFrameLength(sparse.length, decoded.captureTimestampMs);
    gridParts.push(timestamp, sparse);
    gridOffset += timestamp.length + sparse.length;
  }
  if (index >= firstFrame && index <= lastFrame && (index - firstFrame) % frameStride === 0) {
    const oneFrameDump = Buffer.allocUnsafe(21 + length);
    header.copy(oneFrameDump);
    oneFrameDump.writeUInt32LE(1, 12);
    prefix.copy(oneFrameDump, 16);
    record.copy(oneFrameDump, 21);
    const frame = readLMUFramesFromBuffer(oneFrameDump, 1)[0];
    if (!frame || !decodeLMUSourceFrame(frame)) throw new Error(`Selected record ${index} is not a decodable LMU source frame`);
    const decoded = decodeLMUSourceFrame(frame)!;
    if (decoded.schemaVersion !== 3 || !decoded.lmuContext) throw new Error(`Selected record ${index} lacks native v3 context`);
    selectedHash.update(frame);
    selectedFrames++;
    timestamps.push(decoded.captureTimestampMs);
    const sequence = BigInt(decoded.lmuContext.key.captureSequence);
    firstSequence ??= sequence.toString();
    if (previousSequence !== null && sequence > previousSequence + 1n) sequenceGaps += Number(sequence - previousSequence - 1n);
    previousSequence = sequence;
    for (const competitor of decoded.lmuContext.competitors ?? []) {
      const name = competitor.channels["identity.competitor.driver-name"]?.value;
      if (typeof name === "string") names.add(name);
    }
    const sparse = encoder.encode(frame, offset);
    const timestamp = encodeFrameLength(sparse.length, decoded.captureTimestampMs);
    outputParts.push(timestamp, sparse);
    offset += timestamp.length + sparse.length;
  }
  sourceOffset += prefix.length + length;
}
closeSync(file);
if (sourceOffset !== sourceSize || sourceOffset !== statSync(source).size) throw new Error("Source dump has trailing or unparsed bytes");
if (lastFrame >= frameCount) throw new Error("Selection exceeds source frame count");
const sourceSha256 = sourceHash.digest("hex");
const selectedDecodedSha256 = selectedHash.digest("hex");
if (sourceSha256 !== "c596c1b05bf658488f8fe90f3c412e3de1e1446a79baf75b24f583d669a1d1c7") throw new Error(`Source capture changed: ${sourceSha256}`);
if (selectedDecodedSha256 !== "cdec1e517a830a21c28dc9098d4a4ddf1a41de4c05f6d3769f2dad24974b4b10") throw new Error(`Selected native frames changed: ${selectedDecodedSha256}`);
const canonical = Buffer.concat(outputParts);
const roundTripHash = createHash("sha256");
let roundTripFrames = 0;
for (const record of iterateSessionCaptureRecords(canonical, undefined, { strict: true })) {
  if (record.kind !== "frame") throw new Error("Unexpected fixture context record");
  roundTripHash.update(record.frame);
  roundTripFrames++;
}
if (roundTripFrames !== selectedFrames || roundTripHash.digest("hex") !== selectedDecodedSha256) {
  throw new Error("Sparse fixture did not preserve selected native frames");
}
writeFileSync(output, gzipSync(canonical, { level: 9 }));
const gridCanonical = Buffer.concat(gridParts);
const gridDecodedSha256 = gridHash.digest("hex");
const gridRoundTripHash = createHash("sha256");
let gridRoundTripFrames = 0;
for (const record of iterateSessionCaptureRecords(gridCanonical, undefined, { strict: true })) {
  if (record.kind !== "frame") throw new Error("Unexpected grid fixture context record");
  gridRoundTripHash.update(record.frame);
  gridRoundTripFrames++;
}
if (gridRoundTripFrames !== gridFrames || gridRoundTripHash.digest("hex") !== gridDecodedSha256) {
  throw new Error("Sparse grid fixture did not preserve selected native frames");
}
writeFileSync(gridOutput, gzipSync(gridCanonical, { level: 9 }));
console.log(JSON.stringify({ gridOutput, gridFrames, gridFrameRange: [0, 100], gridStride: 2, gridDecodedSha256, gridOpponentNames: [...gridNames].sort(), gridBytes: statSync(gridOutput).size }, null, 2));
console.log(JSON.stringify({ sourceBytes: sourceSize, sourceSha256, frameCount, selectedFrames, frameStride, selectedDecodedSha256, firstFrame, lastFrame, firstTimestampMs: timestamps[0], lastTimestampMs: timestamps.at(-1), firstCaptureSequence: firstSequence, lastCaptureSequence: previousSequence?.toString(), sequenceGaps, opponentNames: [...names].sort(), output, outputBytes: statSync(output).size }, null, 2));
