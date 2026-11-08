import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate before importing any application module that initializes storage.
const directory = process.env.DATA_DIR ?? await mkdtemp(join(tmpdir(), "raceiq-lmu-shutdown-"));
process.env.DATA_DIR = directory;
process.env.NODE_ENV = "production";
process.env.RACEIQ_TEST_MODE = "0";
process.env.RACEIQ_E2E = "1";
process.chdir(directory);
const { LMUTelemetrySource } = await import("@raceiq/game-lmu/source");
const { setLmuSource } = await import("@raceiq/backend/test-support/live-readers");
const { bootServer } = await import("@raceiq/backend/test-support/boot");
const { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE } = await import("@raceiq/capture-formats/lmu/layout");
const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
memory.writeInt32LE(42, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
memory.write("Ferrari 499P", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.vehicleName);
memory.write("Circuit de Spa-Francorchamps", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.trackName);
memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session);
memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
memory.writeInt32LE(42, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.id);
memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
let index = 0;
const source = new LMUTelemetrySource({
  reader: {
    start() {}, async stop() {},
    readLatest() {
      if (index === 32) return null;
      memory.writeDoubleLE(index + 1, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      memory.writeDoubleLE(index + 1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      memory.writeDoubleLE(5100 + index, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineRpm);
      index++;
      return memory;
    },
  },
  recordingEnabled: true, recordingDir: directory, rest: false,
});
const poll = source.pollOnce.bind(source);
source.pollOnce = async () => {
  const accepted = await poll();
  if (accepted && index === 32) console.log(`[E2E] LMU dump admitted 32 frames: ${directory}`);
  return accepted;
};
setLmuSource(source);
await bootServer({ httpPort: 0, udpPort: 0, recordingGameId: "lmu" });
source.start();
