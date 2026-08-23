import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { LapTrace } from "../../../shared/racing/laps/trace/types";
import type { TuneIssue } from "../../../shared/racing/tuning/issues";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";
import { TrackFocusViewInner } from "../components/tunes/track-focus/TrackFocusView";
import { stintStats } from "../lib/stint-traces";

function makeFrame(i: number, n: number, lapTime: number, wobble: number): SemanticAnalysisFrame {
  const f = i / (n - 1);
  const dist = f * 3000;
  const speedMps = (60 + 40 * Math.sin(f * Math.PI * 3) + wobble * Math.sin(f * 40)) / 3.6;
  return {
    values: {
      "timing.distance-traveled": dist,
      "motion.position-x": Math.sin(f * Math.PI * 2) * 400 + Math.sin(f * 9) * 20,
      "motion.position-z": Math.cos(f * Math.PI * 2) * 250 + Math.cos(f * 7) * 15,
      "motion.speed": speedMps,
      "inputs.accel": Math.max(0, Math.min(1, 0.7 + 0.2 * Math.sin(f * Math.PI * 5))) * 255,
      "inputs.brake": (f % 0.3 < 0.05 ? 0.8 : 0) * 255,
      "inputs.steer": (Math.sin(f * Math.PI * 6) + wobble * 0.06) * 127,
      "timing.current-lap": f * lapTime,
      "tire.temperature.average": [85 + 8 * Math.sin(f * 5) + wobble, 87 + 8 * Math.sin(f * 5 + 1) + wobble, 82 + 6 * Math.sin(f * 5 + 2) + wobble, 84 + 6 * Math.sin(f * 5 + 3) + wobble],
      "tires.tire-pressure": [27.5 + 0.2 * Math.sin(f * 3), 27.6 + 0.2 * Math.sin(f * 3 + 1), 26.8 + 0.2 * Math.sin(f * 3 + 2), 26.9 + 0.2 * Math.sin(f * 3 + 3)],
    },
    states: {},
    freshness: {},
  };
}

function makeLapTelemetry(lapTime: number, wobble: number): SemanticAnalysisFrame[] {
  const n = 400;
  return Array.from({ length: n }, (_, i) => makeFrame(i, n, lapTime, wobble));
}

function makeLapTrace(lapId: number, lapNumber: number, isValid: boolean, telemetry: SemanticAnalysisFrame[]): LapTrace {
  const n = telemetry.length;
  const values = (frame: SemanticAnalysisFrame, id: string) => frame.values[id];
  const nums = (id: string) => Float32Array.from(telemetry, (frame) => Number(values(frame, id) ?? 0));
  const temps = telemetry.map((frame) => values(frame, "tire.temperature.average") as number[]);
  const pressure = telemetry.map((frame) => values(frame, "tires.tire-pressure") as number[]);
  const avg = (rows: number[][], index: number) => rows.reduce((sum, row) => sum + row[index], 0) / rows.length;
  return {
    lapId,
    lapNumber,
    isValid,
    n,
    frac: Float32Array.from({ length: n }, (_, i) => i / (n - 1)),
    throttle: Float32Array.from(telemetry, (frame) => Number(values(frame, "inputs.accel") ?? 0) / 255),
    brake: Float32Array.from(telemetry, (frame) => Number(values(frame, "inputs.brake") ?? 0) / 255),
    steer: Float32Array.from(telemetry, (frame) => Number(values(frame, "inputs.steer") ?? 0) / 127),
    speedKmh: Float32Array.from(telemetry, (frame) => Number(values(frame, "motion.speed") ?? 0) * 3.6),
    timeS: Float32Array.from(telemetry, (frame) => Number(values(frame, "timing.current-lap") ?? 0)),
    tire: { FL: avg(temps, 0), FR: avg(temps, 1), RL: avg(temps, 2), RR: avg(temps, 3) },
    pressure: { FL: avg(pressure, 0), FR: avg(pressure, 1), RL: avg(pressure, 2), RR: avg(pressure, 3) },
    tireTempTrace: null,
    pressureTrace: null,
    balance: null,
    latG: null,
    longG: null,
    suspTravel: null,
    combinedSlip: null,
    brakeTemp: null,
    brakeTempTrace: null,
  };
}

const LAP_TIMES = [92.4, 91.8, 91.55, 91.9, 91.3, 92.1];
const laps: LapMeta[] = LAP_TIMES.map((t, i) => ({
  id: i + 1,
  sessionId: 1,
  lapNumber: i + 1,
  lapTime: t,
  isValid: i !== 3,
  phase: "flying",
  conditions: [],
  paceEligibility: "eligible",
  createdAt: new Date().toISOString(),
  sectorTimes: [t * 0.32, t * 0.4, t * 0.28],
}));

const telemetryByLap = new Map(laps.map((l, i) => [l.id, makeLapTelemetry(l.lapTime, i === 3 ? 40 : 6)]));

const traces = laps.map((l) => makeLapTrace(l.id, l.lapNumber, l.isValid, telemetryByLap.get(l.id)!));

const bestLap = laps.reduce((a, b) => (b.isValid && b.lapTime < a.lapTime ? b : a), laps[0]);

const issues: TuneIssue[] = [
  { kind: "oversteer", severity: "warn", corner: "T4", distanceFrac: 0.32, detail: "Rear steps out mid-corner at T4 (-0.15 slip angle)" },
  { kind: "brake-lockup", severity: "critical", corner: "T7", distanceFrac: 0.61, detail: "FL locking under braking into T7 (-0.28 slip)" },
  { kind: "tyre-pressure", severity: "info", detail: "Average rear pressure trending 0.3 bar low across the stint" },
];

const meta: Meta<typeof TrackFocusViewInner> = {
  title: "Tunes/TrackFocusView",
  component: TrackFocusViewInner,
};
export default meta;

type Story = StoryObj<typeof TrackFocusViewInner>;

export const Default: Story = {
  args: {
    laps,
    traces,
    bestLapId: bestLap.id,
    focusLapId: bestLap.id,
    onFocusLap: () => {},
    lineSpread: null,
    focusTelemetry: telemetryByLap.get(bestLap.id) ?? null,
    focusSectorTimes: null,
    edges: null,
    corners: [
      { index: 0, label: "T1", distanceStart: 0.08, distanceEnd: 0.12 },
      { index: 1, label: "T4", distanceStart: 0.35, distanceEnd: 0.4 },
      { index: 2, label: "T7", distanceStart: 0.7, distanceEnd: 0.75 },
    ],
    issues,
    stats: stintStats(laps),
  },
};

export const NoIssues: Story = {
  args: {
    ...Default.args,
    issues: [],
    stats: stintStats(laps),
  },
};

export const Empty: Story = {
  args: {
    laps: [],
    traces: [],
    bestLapId: null,
    focusLapId: null,
    onFocusLap: () => {},
    lineSpread: null,
    focusTelemetry: null,
    focusSectorTimes: null,
    edges: null,
    corners: [],
    issues: [],
    stats: stintStats([]),
  },
};
