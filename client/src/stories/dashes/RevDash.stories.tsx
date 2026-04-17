import type { Meta, StoryObj } from "@storybook/react";
import { RevDash } from "../../components/dashes/RevDash";
import { DashStoryDecorator, type DashStoryOverrides } from "./decorator";

function wrap(overrides?: DashStoryOverrides) {
  return (
    <DashStoryDecorator overrides={overrides}>
      <RevDash />
    </DashStoryDecorator>
  );
}

const meta: Meta<typeof RevDash> = {
  title: "Dashes/RevDash",
  component: RevDash,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof RevDash>;

export const Default: Story = {
  render: () => wrap(),
};

export const Idle: Story = {
  render: () =>
    wrap({ raw: { CurrentEngineRpm: 3000, Gear: 1 } }),
};

export const Midrange: Story = {
  render: () =>
    wrap({ raw: { CurrentEngineRpm: 11000, Gear: 4 } }),
};

export const RedLine: Story = {
  render: () =>
    wrap({ raw: { CurrentEngineRpm: 17900, Gear: 7 } }),
};

export const Reverse: Story = {
  render: () => wrap({ raw: { CurrentEngineRpm: 4500, Gear: 0 } }),
};

export const Tablet: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
