import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ComboDash } from "../../components/dashes/ComboDash";
import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeSectors,
  fakePit,
} from "../fakeData";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const BASE_RAW = {
  ...fakeForzaPacket,
  BrakeTempFrontLeft: 380,
  BrakeTempFrontRight: 375,
  BrakeTempRearLeft: 240,
  BrakeTempRearRight: 238,
  TirePressureFrontLeft: 27.8,
  TirePressureFrontRight: 27.7,
  TirePressureRearLeft: 26.5,
  TirePressureRearRight: 26.4,
  f1: { ...(fakeForzaPacket.f1 ?? {}), totalLaps: 57 },
} as TelemetryPacket;

const fToC = (f: number) => ((f - 32) * 5) / 9;

function wrap(
  overrides?: {
    raw?: Partial<TelemetryPacket>;
    display?: Partial<DisplayPacket>;
    unitSystem?: "metric" | "imperial";
  },
) {
  const raw = { ...BASE_RAW, ...(overrides?.raw ?? {}) } as TelemetryPacket;
  const display = {
    ...fakeForzaDisplayPacket,
    ...(overrides?.raw ?? {}),
    ...(overrides?.display ?? {}),
  } as DisplayPacket;
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
        <ComboDash
          rawPacket={raw}
          packet={display}
          sectors={fakeSectors}
          pit={fakePit}
          unitSystem={overrides?.unitSystem ?? "metric"}
          toTempC={fToC}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof ComboDash> = {
  title: "Dashes/Combo/Combo Dash 1",
  component: ComboDash,
  parameters: { layout: "fullscreen" },
  argTypes: {
    rpm: {
      control: { type: "range", min: 3000, max: 18000, step: 50 },
      description: "Live RPM (drive the rev bar interactively)",
    },
    gear: {
      control: { type: "range", min: 0, max: 10, step: 1 },
      description: "Gear (0 = R, 1 = N, 2+ = forward gears)",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ComboDash & { rpm?: number; gear?: number }>;

export const Default: Story = {
  args: { rpm: 14200, gear: 7 },
  render: (args) =>
    wrap({
      raw: { CurrentEngineRpm: args.rpm ?? 14200, Gear: args.gear ?? 7 },
    }),
};

export const NoData: Story = {
  render: () => (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
        <ComboDash
          rawPacket={null}
          packet={null}
          sectors={null}
          pit={null}
          unitSystem="metric"
          toTempC={fToC}
        />
      </div>
    </QueryClientProvider>
  ),
};

export const RedLine: Story = {
  render: () =>
    wrap({
      raw: { CurrentEngineRpm: 17900, Gear: 7 },
      display: { DisplaySpeed: 315 },
    }),
};

export const UnderBest: Story = {
  render: () =>
    wrap({
      raw: {
        LapNumber: 6,
        CurrentLap: 45.2,
        LastLap: 91.88,
        BestLap: 92.341,
      },
    }),
};

export const Phone: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "iphone14Landscape", isRotated: false } },
};

export const TabletPortrait: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadMini", isRotated: false } },
};
