import type { Meta, StoryObj } from "@storybook/react";
import { SpeedDash } from "../../components/dashes/SpeedDash";
import { fakeForzaDisplayPacket } from "../fakeData";
import type { DisplayPacket } from "../../lib/convert-packet";

function wrap(
  overrides?: { display?: Partial<DisplayPacket>; unitSystem?: "metric" | "imperial" },
) {
  const packet = { ...fakeForzaDisplayPacket, ...(overrides?.display ?? {}) } as DisplayPacket;
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      <SpeedDash packet={packet} unitSystem={overrides?.unitSystem ?? "metric"} />
    </div>
  );
}

const meta: Meta<typeof SpeedDash> = {
  title: "Dashes/SpeedDash",
  component: SpeedDash,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof SpeedDash>;

export const Metric: Story = {
  render: () => wrap({ display: { DisplaySpeed: 260 }, unitSystem: "metric" }),
};
export const Imperial: Story = {
  render: () => wrap({ display: { DisplaySpeed: 162 }, unitSystem: "imperial" }),
};
export const Standstill: Story = {
  render: () => wrap({ display: { DisplaySpeed: 0 }, unitSystem: "metric" }),
};
export const TopSpeed: Story = {
  render: () => wrap({ display: { DisplaySpeed: 332 }, unitSystem: "metric" }),
};
export const Tablet: Story = {
  render: () => wrap({ display: { DisplaySpeed: 260 }, unitSystem: "metric" }),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
