/**
 * Rebuild the deterministic iRacing recorder fixture used by parser/pipeline
 * regression tests. The samples model the SDK's delayed lap-timer rollover and
 * are written through the production source-frame encoder and recorder.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { gzipSync } from "zlib";
import {
  IRacingRecorder,
} from "../server/games/iracing/recorder";
import {
  IRacingSourceFrameEncoder,
  type IRacingSessionSnapshot,
  type IRacingSourceFrameV2,
  type IRacingValue,
} from "../server/games/iracing/source-frame";

const TRACK_LENGTH_M = 6_515;
const OUTPUT = resolve(
  import.meta.dir,
  "..",
  "test",
  "artifacts",
  "sessions",
  "iracing-road-america-gt3.bin.gz",
);

const session: IRacingSessionSnapshot = {
  sessionId: 123,
  subSessionId: 456,
  sessionNum: 2,
  driverCarIdx: 7,
  trackId: 99,
  trackName: "Road America",
  trackLengthM: TRACK_LENGTH_M,
  sectorStarts: [0, 0.34, 0.67],
  carId: 42,
  carName: "GT3 Test Car",
  carClassId: 8,
  carClassName: "GT3",
  engineIdleRpm: 900,
  engineRedlineRpm: 8_500,
  engineCylinderCount: 8,
};

const frames: IRacingSourceFrameV2[] = [];

function addFrame(
  lap: number,
  sessionTime: number,
  sdkCurrentLapTime: number,
  lastLapTime: number,
  lapDistancePct: number,
): void {
  const phase = lapDistancePct * Math.PI * 2;
  const speed = 58 + Math.sin(phase - 0.4) * 18;
  const braking = Math.max(0, Math.sin(phase * 3 + 0.7));
  const values: Record<string, IRacingValue> = {
    SessionTime: sessionTime,
    SessionTick: Math.round(sessionTime * 60),
    SessionNum: session.sessionNum,
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerTrackSurface: 3,
    PlayerIncidents: 0,
    PlayerCarPosition: 1,
    Speed: speed,
    RPM: 5_500 + speed * 35,
    Throttle: 1 - braking * 0.75,
    Brake: braking * 0.8,
    Clutch: 0,
    Gear: Math.max(2, Math.min(6, Math.round(speed / 12))),
    SteeringWheelAngle: Math.sin(phase * 4) * 0.35,
    SteeringWheelAngleMax: 7.85,
    FuelLevel: 42 - sessionTime * 0.004,
    Lap: lap,
    LapCompleted: Math.max(0, lap - 1),
    LapDist: lapDistancePct * TRACK_LENGTH_M,
    LapDistPct: lapDistancePct,
    LapBestLapTime: 31.917,
    LapLastLapTime: lastLapTime,
    LapCurrentLapTime: sdkCurrentLapTime,
    LatAccel: Math.sin(phase * 4) * 7,
    LongAccel: (1 - braking * 2) * 2,
    VertAccel: 9.81,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: speed,
    Yaw: phase,
    Pitch: 0,
    Roll: Math.sin(phase * 4) * 0.03,
    YawRate: Math.cos(phase * 4) * 0.2,
    PitchRate: 0,
    RollRate: 0,
    TrackTemp: 32,
    AirTemp: 23,
    Precipitation: 0,
    TrackWetness: 1,
    LFshockDefl: 0.045,
    RFshockDefl: 0.044,
    LRshockDefl: 0.051,
    RRshockDefl: 0.05,
    LFtempCL: 86,
    LFtempCM: 87,
    LFtempCR: 85,
    RFtempCL: 85,
    RFtempCM: 86,
    RFtempCR: 84,
    LRtempCL: 83,
    LRtempCM: 84,
    LRtempCR: 82,
    RRtempCL: 82,
    RRtempCM: 83,
    RRtempCR: 81,
    LFwearL: 0.95,
    LFwearM: 0.94,
    LFwearR: 0.96,
    RFwearL: 0.95,
    RFwearM: 0.94,
    RFwearR: 0.96,
    LRwearL: 0.96,
    LRwearM: 0.95,
    LRwearR: 0.97,
    RRwearL: 0.96,
    RRwearM: 0.95,
    RRwearR: 0.97,
    LFcoldPressure: 179,
    RFcoldPressure: 179,
    LRcoldPressure: 176,
    RRcoldPressure: 176,
  };
  frames.push({ schemaVersion: 2, session, values });
}

// Initial partial lap. The native detector deliberately discards it.
addFrame(0, 100, 20, 0, 0.5);
addFrame(1, 100.02, 20.02, 20, 0);

// First complete physical lap.
for (let index = 1; index <= 64; index++) {
  const elapsed = (31.917 * index) / 64;
  addFrame(1, 100.02 + elapsed, elapsed, 20, index / 65);
}
addFrame(2, 131.937, 31.917, 20, 0);
addFrame(2, 133.737, 1.8, 31.917, 1.8 / 32.045);

// Second complete physical lap.
for (let index = 5; index <= 64; index++) {
  const elapsed = (32.045 * index) / 64;
  addFrame(2, 131.937 + elapsed, elapsed, 31.917, index / 65);
}
addFrame(3, 163.982, 32.045, 31.917, 0);
addFrame(3, 165.782, 1.8, 32.045, 1.8 / 33);

// Leave a short third lap in progress so EOF flushing is covered too.
for (let index = 5; index <= 12; index++) {
  const elapsed = (33 * index) / 64;
  addFrame(3, 163.982 + elapsed, elapsed, 32.045, index / 65);
}

const tempDir = mkdtempSync(resolve(tmpdir(), "raceiq-iracing-fixture-"));
const recorder = new IRacingRecorder();
const encoder = new IRacingSourceFrameEncoder();

try {
  recorder.start(tempDir);
  for (const frame of frames) {
    recorder.writeFrame(encoder.encode(frame));
  }
  await recorder.stop();
  const recorded = readFileSync(recorder.path!);
  writeFileSync(OUTPUT, gzipSync(recorded, { level: 9 }));
  console.log(`Wrote ${frames.length} frames to ${OUTPUT}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
