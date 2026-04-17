import type { Meta, StoryObj } from "@storybook/react";
import { SpeedDash } from "../../components/dashes/SpeedDash";
import { DashStoryDecorator, type DashStoryOverrides } from "./decorator";

function wrap(overrides?: DashStoryOverrides) {
  return (
    <DashStoryDecorator overrides={overrides}>
      <SpeedDash />
    </DashStoryDecorator>
  );
}

const meta: Meta<typeof SpeedDash> = {
  title: "Dashes/SpeedDash",
  component: SpeedDash,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "iphone14" },
  },
};

export default meta;
type Story = StoryObj<typeof SpeedDash>;

export const Metric: Story = {
  render: () =>
    wrap({ display: { DisplaySpeed: 260 }, unitSystem: "metric" }),
};

export const Imperial: Story = {
  render: () =>
    wrap({ display: { DisplaySpeed: 162 }, unitSystem: "imperial" }),
};

export const Standstill: Story = {
  render: () => wrap({ display: { DisplaySpeed: 0 }, unitSystem: "metric" }),
};

export const TopSpeed: Story = {
  render: () =>
    wrap({ display: { DisplaySpeed: 332 }, unitSystem: "metric" }),
};

export const Tablet: Story = {
  render: () => wrap({ display: { DisplaySpeed: 260 }, unitSystem: "metric" }),
  parameters: { viewport: { defaultViewport: "ipadLandscape" } },
};
