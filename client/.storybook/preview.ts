import type { Preview } from "@storybook/react";
import "../src/index.css";
import { initGameAdapters } from "../../shared/games/init";

// Initialize game adapter registry so tryGetGame() works in stories
initGameAdapters();

// Apply dark mode class and app theme to Storybook's iframe <html> element
// so CSS variables (--app-bg, --app-border etc) resolve correctly
document.documentElement.classList.add("dark");
document.documentElement.setAttribute("data-theme", "morph");

// The app's global CSS (imported above) locks `html, body, #root` to
// `height: 100%; overflow: hidden` so in-app scroll containers work. That
// also prevents the Storybook Docs page from scrolling. Override on the
// docs preview iframe only (it mounts content under `#storybook-docs`).
const docsScrollFix = document.createElement("style");
docsScrollFix.textContent = `
  html:has(#storybook-docs),
  html:has(#storybook-docs) body,
  html:has(#storybook-docs) #root {
    height: auto !important;
    overflow: auto !important;
  }
`;
document.head.appendChild(docsScrollFix);

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
      options: {
        "1080p": {
          name: "1920×1080 (16:9)",
          styles: { width: "1920px", height: "1080px" },
          type: "desktop",
        },
        iphone14: {
          name: "iPhone 14 (390×844)",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        iphone14Landscape: {
          name: "iPhone 14 Landscape (844×390)",
          styles: { width: "844px", height: "390px" },
          type: "mobile",
        },
        ipadMini: {
          name: "iPad Mini (768×1024)",
          styles: { width: "768px", height: "1024px" },
          type: "tablet",
        },
        ipadLandscape: {
          name: "iPad Landscape (1024×768)",
          styles: { width: "1024px", height: "768px" },
          type: "tablet",
        },
      },
    },
  },
};

export default preview;
