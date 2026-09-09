import type { Meta, StoryObj } from "@storybook/react";
import { TrackSpeedChart } from "../components/telemetry/TrackSpeedChart";
import type { TrackSpeedSample } from "../lib/gearing-telemetry";

/** Synthetic lap: slow corners + fast straights over ~4.5 km, sampled at ~10 Hz. */
function fakeLapTrace(distMetres: number, n = 450): TrackSpeedSample[] {
  const out: TrackSpeedSample[] = [];
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * distMetres;
    const speed = 45 + 130 * Math.abs(Math.sin(d / 550)) + 35 * Math.sin(d / 230);
    out.push({ distance: d, speed: Math.max(0, speed), gear: 1 + Math.min(5, Math.floor(d / 750)) });
  }
  return out;
}

const meta: Meta<typeof TrackSpeedChart> = {
  title: "Telemetry/TrackSpeedChart",
  component: TrackSpeedChart,
  decorators: [
    (Story) => (
      <div style={{ width: 860, background: "var(--app-bg)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TrackSpeedChart>;
export const WithPreviousLap: Story = {
  args: {
    laps: {
      current: { lapNumber: 4, samples: fakeLapTrace(4500) },
      previous: { lapNumber: 3, samples: fakeLapTrace(4500, 420).map((s) => ({ ...s, speed: s.speed * 0.75 })) },
    },
    toDistance: (m: number) => m / 1000,
    distanceLabel: "km",
    speedLabel: "km/h",
  },
};

export const Empty: Story = {
  args: {
    laps: { current: null, previous: null },
    toDistance: (m: number) => m / 1000,
    distanceLabel: "km",
    speedLabel: "km/h",
  },
};
