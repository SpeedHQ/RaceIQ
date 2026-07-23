import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrackFocusViewInner } from "../components/tunes/track-focus/TrackFocusView";
import { downsampleLap, stintStats } from "../lib/stint-traces";

function makePacket(i: number, n: number, lapTime: number, wobble: number): TelemetryPacket {
  const f = i / (n - 1);
  const dist = f * 3000;
  const speed = (60 + 40 * Math.sin(f * Math.PI * 3) + wobble * Math.sin(f * 40)) / 3.6;
  return {
    TimestampMS: Math.round(f * lapTime * 1000),
    DistanceTraveled: dist,
    PositionX: Math.sin(f * Math.PI * 2) * 400 + Math.sin(f * 9) * 20,
    PositionZ: Math.cos(f * Math.PI * 2) * 250 + Math.cos(f * 7) * 15,
    Speed: speed,
    Accel: Math.max(0, Math.min(255, 180 + 60 * Math.sin(f * Math.PI * 5))),
    Brake: Math.max(0, Math.min(255, f % 0.3 < 0.05 ? 200 : 0)),
    Steer: Math.round(Math.sin(f * Math.PI * 6) * 100 + wobble * 8),
    TireTempFL: 85 + 8 * Math.sin(f * 5) + wobble,
    TireTempFR: 87 + 8 * Math.sin(f * 5 + 1) + wobble,
    TireTempRL: 82 + 6 * Math.sin(f * 5 + 2) + wobble,
    TireTempRR: 84 + 6 * Math.sin(f * 5 + 3) + wobble,
    TirePressureFrontLeft: 27.5 + 0.2 * Math.sin(f * 3),
    TirePressureFrontRight: 27.6 + 0.2 * Math.sin(f * 3 + 1),
    TirePressureRearLeft: 26.8 + 0.2 * Math.sin(f * 3 + 2),
    TirePressureRearRight: 26.9 + 0.2 * Math.sin(f * 3 + 3),
  } as unknown as TelemetryPacket;
}

function makeLapTelemetry(lapTime: number, wobble: number): TelemetryPacket[] {
  const n = 400;
  return Array.from({ length: n }, (_, i) => makePacket(i, n, lapTime, wobble));
}

const LAP_TIMES = [92.4, 91.8, 91.55, 91.9, 91.3, 92.1];
const laps: LapMeta[] = LAP_TIMES.map((t, i) => ({
  id: i + 1,
  sessionId: 1,
  lapNumber: i + 1,
  lapTime: t,
  isValid: i !== 3,
  createdAt: new Date().toISOString(),
  s1Time: t * 0.32,
  s2Time: t * 0.4,
  s3Time: t * 0.28,
  isLegacy: false,
}));

const telemetryByLap = new Map(laps.map((l, i) => [l.id, makeLapTelemetry(l.lapTime, i === 3 ? 40 : 6)]));

const traces = laps.map((l) => downsampleLap(l.id, l.lapNumber, l.isValid, telemetryByLap.get(l.id)!, null));

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
    focusTelemetry: telemetryByLap.get(bestLap.id) ?? null,
    focusSectorTimes: null,
    edges: null,
    corners: [
      { index: 0, label: "T1", distanceStart: 200, distanceEnd: 320 },
      { index: 1, label: "T4", distanceStart: 900, distanceEnd: 1020 },
      { index: 2, label: "T7", distanceStart: 1800, distanceEnd: 1950 },
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
    focusTelemetry: null,
    focusSectorTimes: null,
    edges: null,
    corners: [],
    issues: [],
    stats: stintStats([]),
  },
};
