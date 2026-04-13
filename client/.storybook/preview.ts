import type { Preview } from "@storybook/react";
import "../src/index.css";
import { initGameAdapters } from "../../shared/games/init";

// Initialize game adapter registry so tryGetGame() works in stories
initGameAdapters();

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#0a0a0a" },
        { name: "light", value: "#ffffff" },
      ],
    },
    viewport: {
      viewports: {
        "1080p": {
          name: "1920×1080 (16:9)",
          styles: { width: "1920px", height: "1080px" },
          type: "desktop",
        },
      },
      defaultViewport: "1080p",
    },
  },
};

export default preview;
