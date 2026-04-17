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
  title: "Dashes/ComboDash",
  component: ComboDash,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "ipadLandscape" },
  },
};

export default meta;
type Story = StoryObj<typeof ComboDash>;

export const Default: Story = {
  render: () => wrap(),
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
  parameters: { viewport: { defaultViewport: "iphone14Landscape" } },
};

export const TabletPortrait: Story = {
  render: () => wrap(),
  parameters: { viewport: { defaultViewport: "ipadMini" } },
};
