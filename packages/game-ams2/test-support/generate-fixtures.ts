import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { AMS2_DUMP_MAGIC, readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { encodeAMS2Frame } from "../src/frame";
import { AMS2_LAYOUT as L, AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P, PARTICIPANT_SIZE } from "../src/layout";

const sources = {
  "time-trial": "ams2-2026-10-10T01-57-36-584Z-e42183c3.bin",
  "race-pit-stop": "ams2-2026-10-11T21-14-35-509Z-ff876e52.bin",
  "weekend-sparse-qualifying": "ams2-2026-10-11T23-25-00-375Z-a722b396.bin",
  "qualifying": "ams2-2026-10-12T02-09-48-415Z-c7bd6ffa.bin",
};

// Keep real state changes and their preceding sample, plus at most 10 Hz otherwise.
// Capture extensions are intentionally excluded: these fixtures test decoded ABI fields.
function state(raw: Buffer): string {
  const m = raw.subarray(24);
  const viewed = m.readInt32LE(L.mViewedParticipantIndex);
  const p = P + Math.max(0, Math.min(63, viewed)) * PARTICIPANT_SIZE;
  return [m.readUInt32LE(L.mGameState), m.readUInt32LE(L.mSessionState),
    m.readUInt32LE(L.mRaceState), viewed, m.readInt32LE(L.mNumParticipants),
    m.readUInt32LE(p + 88), m.readUInt32LE(p + 92), m[L.mLapInvalidated], m.readUInt32LE(L.mPitMode),
    m.readFloatLE(L.mCurrentTime) < 0, m.readFloatLE(p + 80) < 30].join(":");
}

const sourceDir = resolve(Bun.argv[2] ?? "test/artifacts/sessions");
const output = resolve(import.meta.dir, "../../../test/artifacts/sessions");
mkdirSync(output, { recursive: true });
const manifest = [];
for (const [name, source] of Object.entries(sources)) {
  const frames: Buffer[] = [];
  let previous: Buffer | null = null;
  let previousState = "";
  let lastAdded: Buffer | null = null;
  let lastTime = -Infinity;
  let sourceFrames = 0;
  const sourceHash = createHash("sha256");
  const add = (raw: Buffer) => {
    if (raw === lastAdded) return;
    const memory = Buffer.from(raw.subarray(24, 24 + AMS2_MEMORY_SIZE));
    for (let i = 0; i < 64; i++) {
      const start = P + i * PARTICIPANT_SIZE + 1;
      memory.fill(0, start, start + 64);
    }
    frames.push(encodeAMS2Frame(memory, raw.readDoubleLE(8), raw.readUInt32LE(16)));
    lastAdded = raw;
    lastTime = raw.readDoubleLE(8);
  };
  for await (const raw of readAMS2DumpFrames(resolve(sourceDir, source))) {
    sourceFrames++;
    sourceHash.update(raw);
    const key = state(raw);
    if (key !== previousState) {
      if (previous) add(previous);
      add(raw);
    } else if (raw.readDoubleLE(8) - lastTime >= 100) add(raw);
    previous = raw;
    previousState = key;
  }
  if (previous) add(previous);
  const header = Buffer.alloc(16);
  AMS2_DUMP_MAGIC.copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(frames.length, 12);
  const parts: Buffer[] = [header];
  for (const frame of frames) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(frame.length);
    parts.push(size, frame);
  }
  const compressed = gzipSync(Buffer.concat(parts), { level: 9 });
  writeFileSync(resolve(output, `ams2-${name}.bin.gz`), compressed);
  manifest.push({ name, source, sourceFrames, sourceFramesSha256: sourceHash.digest("hex"),
    fixtureFrames: frames.length, bytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex") });
  console.log(name, frames.length, compressed.length);
}
writeFileSync(resolve(output, "ams2-fixtures.json"), JSON.stringify(manifest, null, 2) + "\n");
