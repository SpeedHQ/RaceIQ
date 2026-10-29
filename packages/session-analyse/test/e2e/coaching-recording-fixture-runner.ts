import { IRacingSourceFrameEncoder, type IRacingSourceFrame } from "@raceiq/capture-formats/iracing/source-frame";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";

type CoachingSignal = "brake-drag" | "downshift" | "steering" | "throttle";
type InputChannel = "throttle" | "brake" | "steering" | "rpm";
type OmittedChannel = "distance" | "speed" | "position";
type DistanceProfile = "variable";
interface Options { lapCount: number; signals: CoachingSignal[]; omittedChannels: OmittedChannel[]; inputs: InputChannel[]; distanceProfile?: DistanceProfile }

const LAP_SECONDS = 60;
const FRAME_SECONDS = 0.1;
const FRAME_COUNT = LAP_SECONDS / FRAME_SECONDS;
const TRACK_LENGTH_M = 4_000;

function sourceFrame(lap: number, frame: number, signals: ReadonlySet<CoachingSignal>, omittedChannels: ReadonlySet<OmittedChannel>, inputs: ReadonlySet<InputChannel>, distanceProfile?: DistanceProfile): IRacingSourceFrame {
  const frameFraction = frame / FRAME_COUNT;
  const fraction = distanceProfile === "variable" ? frameFraction - 0.04 * Math.sin(2 * Math.PI * frameFraction) : frameFraction;
  const sessionTime = lap * LAP_SECONDS + frame * FRAME_SECONDS;
  let throttle = 0;
  let brake = 0;
  let gear = 4;
  let rpm = 6_000;
  let steering = 0;

  if (signals.has("brake-drag") && frameFraction >= 0.15 && frameFraction < 0.20) {
    throttle = 0.9;
    brake = 0.1;
  }
  if (signals.has("downshift") && frameFraction >= 0.35 && frameFraction < 0.36) {
    gear = 3;
    rpm = 7_000;
  }
  if (signals.has("steering") && frameFraction >= 0.55 && frameFraction < 0.65) {
    steering = (frame - Math.floor(0.55 * FRAME_COUNT)) % 2 === 0 ? 0.5 : -0.5;
  }
  if (signals.has("throttle")) {
    if (frameFraction >= 0.78 && frameFraction < 0.82) brake = 0.5;
    else if (frameFraction >= 0.82 && frameFraction < 0.85) throttle = 0;
    else if (frameFraction >= 0.85 && frameFraction < 0.90) { throttle = 0.8; steering = 0.3; }
  }

  return {
    schemaVersion: 2,
    session: {
      sessionId: 3,
      subSessionId: 3,
      sessionNum: 1,
      driverCarIdx: 0,
      trackId: 99,
      trackName: "Road America",
      trackLengthM: TRACK_LENGTH_M,
      sectorStarts: [0, 1 / 3, 2 / 3],
      carId: 42,
      carName: "GT3 Test Car",
      carClassId: 1,
      carClassName: "GT3",
      engineIdleRpm: 1_000,
      engineRedlineRpm: 7_200,
      engineCylinderCount: 8,
    },
    values: {
      SessionTick: (lap * FRAME_COUNT + frame) * 6,
      SessionTime: sessionTime,
      SessionNum: 1,
      IsOnTrack: true,
      OnPitRoad: false,
      ...(omittedChannels.has("speed") ? {} : { Speed: (distanceProfile === "variable" ? 1 - 0.08 * Math.PI * Math.cos(2 * Math.PI * frameFraction) : 1) * TRACK_LENGTH_M / LAP_SECONDS }),
      Lap: lap,
      LapLastLapTime: lap === 0 ? 0 : LAP_SECONDS,
      LapCurrentLapTime: lap > 0 && frame === 0 ? LAP_SECONDS : frame * FRAME_SECONDS,
      ...(omittedChannels.has("distance") ? {} : { LapDist: fraction * TRACK_LENGTH_M, LapDistPct: fraction }),
      ...(omittedChannels.has("position") ? {} : { PlayerCarPosition: 1 }),
      ...(inputs.has("throttle") ? { Throttle: throttle } : {}),
      ...(inputs.has("brake") ? { Brake: brake } : {}),
      Clutch: 0,
      Gear: gear,
      ...(inputs.has("steering") ? { SteeringWheelAngle: steering, SteeringWheelAngleMax: 1 } : {}),
      ...(inputs.has("rpm") ? { RPM: rpm } : {}),
      PlayerTrackSurface: 3,
      FuelLevel: 50,
    },
  };
}

const [path, optionsJson] = process.argv.slice(2);
if (!path || !optionsJson) throw new Error("Expected recording path and fixture options");
const { lapCount, signals, omittedChannels, inputs, distanceProfile } = JSON.parse(optionsJson) as Options;
const recorder = new SparseSessionRecorder("iracing");
const encoder = new IRacingSourceFrameEncoder();
const signalSet = new Set(signals);
const omittedChannelSet = new Set(omittedChannels);
const inputSet = new Set(inputs);
recorder.start(path);
recorder.writeMetaFrame();
for (let lap = 0; lap <= lapCount; lap++) {
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const time = (lap * FRAME_COUNT + frame) * 100;
    recorder.writeRecord(encoder.encode(sourceFrame(lap, frame, signalSet, omittedChannelSet, inputSet, distanceProfile)), time);
  }
}
// Native lap 0 is warmup; detector intentionally skips it before scored laps 1..N.
recorder.writeRecord(encoder.encode(sourceFrame(lapCount + 1, 0, signalSet, omittedChannelSet, inputSet, distanceProfile)), (lapCount + 1) * LAP_SECONDS * 1_000);
recorder.writeRecord(encoder.encode(sourceFrame(lapCount + 1, 1, signalSet, omittedChannelSet, inputSet, distanceProfile)), ((lapCount + 1) * FRAME_COUNT + 1) * 100);
await recorder.stop();
