import type { Meta, StoryObj } from "@storybook/react";
import { TrackWall } from "./marketing/TrackWall";

const meta = {
  title: "Marketing/Track Wall",
  component: TrackWall,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "1080p" },
  },
} satisfies Meta<typeof TrackWall>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BrowseBackground: Story = {};
