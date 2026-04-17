import type { Meta, StoryObj } from "@storybook/react";
import { LapDash } from "../../components/dashes/LapDash";
import { DashStoryDecorator, type DashStoryOverrides } from "./decorator";

function wrap(overrides?: DashStoryOverrides) {
  return (
    <DashStoryDecorator overrides={overrides}>
      <LapDash />
    </DashStoryDecorator>
  );
}

const meta: Meta<typeof LapDash> = {
  title: "Dashes/LapDash",
  component: LapDash,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "iphone14" },
  },
};

export default meta;
type Story = StoryObj<typeof LapDash>;

export const Default: Story = {
  render: () => wrap(),
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

export const OverBest: Story = {
  render: () =>
    wrap({
      raw: {
        LapNumber: 6,
        CurrentLap: 45.2,
        LastLap: 93.512,
        BestLap: 92.341,
      },
    }),
};

export const NoBestYet: Story = {
  render: () =>
    wrap({
      raw: {
        LapNumber: 1,
        CurrentLap: 12.4,
        LastLap: 0,
        BestLap: 0,
      },
    }),
};

export const Tablet: Story = {
  render: () => wrap(),
  parameters: { viewport: { defaultViewport: "ipadMini" } },
};
