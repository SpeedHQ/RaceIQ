import type { Meta, StoryObj } from "@storybook/react";
import { ComboDash2 } from "../../components/dashes/ComboDash2";
import { DashStoryDecorator, type DashStoryOverrides } from "./decorator";

function wrap(overrides?: DashStoryOverrides) {
  return (
    <DashStoryDecorator overrides={overrides}>
      <ComboDash2 />
    </DashStoryDecorator>
  );
}

const meta: Meta<typeof ComboDash2> = {
  title: "Dashes/Combo Dash 2",
  component: ComboDash2,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ComboDash2>;

export const Default: Story = {
  render: () => wrap(),
};

export const Tablet: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
