import type { Meta, StoryObj } from "@storybook/react";
import { RevDash } from "../../components/dashes/RevDash";
import { fakeForzaDisplayPacket } from "../fakeData";
import type { DisplayPacket } from "../../lib/convert-packet";

function wrap(overrides?: Partial<DisplayPacket>) {
  const packet = { ...fakeForzaDisplayPacket, ...(overrides ?? {}) } as DisplayPacket;
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      <RevDash packet={packet} />
    </div>
  );
}

const meta: Meta<typeof RevDash> = {
  title: "Dashes/RevDash",
  component: RevDash,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof RevDash>;

export const Default: Story = { render: () => wrap() };
export const NoData: Story = {
  render: () => (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      <RevDash packet={null} />
    </div>
  ),
};
export const Idle: Story = { render: () => wrap({ CurrentEngineRpm: 3000, Gear: 1 }) };
export const Midrange: Story = { render: () => wrap({ CurrentEngineRpm: 11000, Gear: 4 }) };
export const RedLine: Story = { render: () => wrap({ CurrentEngineRpm: 17900, Gear: 7 }) };
export const Reverse: Story = { render: () => wrap({ CurrentEngineRpm: 4500, Gear: 0 }) };
export const Tablet: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
