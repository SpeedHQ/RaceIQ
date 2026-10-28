import { copyFile, readFile, writeFile } from "node:fs/promises";
import { containsSparseCaptureFrames, decompressIfGzipSync } from "@raceiq/capture-formats/session/framing";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { decodeLMUSourceFrame, encodeLMUSourcePayload } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_TELEMETRY, LMU_WHEEL, LMU_WHEEL_SIZE } from "@raceiq/capture-formats/lmu/layout";

const [source, target, energyMode] = process.argv.slice(2);
if (!source || !target) throw new Error("Expected source and target recording paths");
const raw = decompressIfGzipSync(await readFile(source));
if (containsSparseCaptureFrames(raw)) {
  if (energyMode) throw new Error("Controlled energy fixtures require native LMU source frames");
  await writeFile(target, raw);
}
else {
  let frames = readLMUFramesFromBuffer(raw);
  if (energyMode) {
    if (!["strategy-energy", "strategy-low-energy", "strategy-zero-energy", "strategy-missing-energy"].includes(energyMode)) throw new Error("Unknown strategy energy fixture mode");
    let firstElapsed: number | null = null;
    frames = frames.map((bytes) => {
      const frame = decodeLMUSourceFrame(bytes);
      if (!frame) throw new Error("Expected native LMU source frame");
      const telemetry = Buffer.from(frame.telemetry);
      const elapsed = telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime);
      firstElapsed ??= elapsed;
      const progress = Math.max(0, (elapsed - firstElapsed) / 300);
      // Define reliable native resource/compound channels; retain real fuel, timing and lap boundaries.
      const energyRate = energyMode === "strategy-zero-energy" ? 0 : energyMode === "strategy-low-energy" ? 0.09 : 0.18;
      telemetry.writeFloatLE(energyMode === "strategy-missing-energy" ? NaN : Math.max(0, 0.95 - energyRate * progress), LMU_TELEMETRY.virtualEnergy);
      for (let wheel = 0; wheel < 4; wheel++) {
        telemetry.writeDoubleLE(0.95 - (wheel + 1) * 0.001 * progress, LMU_TELEMETRY.wheels + wheel * LMU_WHEEL_SIZE + LMU_WHEEL.wear);
      }
      for (const offset of [LMU_TELEMETRY.frontTireCompoundName, LMU_TELEMETRY.rearTireCompoundName]) {
        telemetry.fill(0, offset, offset + 18);
        telemetry.write("medium", offset, "utf8");
      }
      return encodeLMUSourcePayload({ ...frame, telemetry });
    });
  }
  const converted = await convertSeedFramesToSparse("lmu", frames);
  try { await copyFile(converted.path, target); }
  finally { converted.cleanup(); }
}
