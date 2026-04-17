import type { Meta, StoryObj } from "@storybook/react";
import { ComboDash } from "../../components/dashes/ComboDash";
import { DashStoryDecorator, type DashStoryOverrides } from "./decorator";

function wrap(overrides?: DashStoryOverrides) {
  return (
    <DashStoryDecorator overrides={overrides}>
      <ComboDash />
    </DashStoryDecorator>
  );
}

const meta: Meta<typeof ComboDash> = {
  title: "Dashes/Combo Dash 1",
  component: ComboDash,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ComboDash>;

export const Default: Story = {
  render: () => wrap({ totalLaps: 57 }),
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
