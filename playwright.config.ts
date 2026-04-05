import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    baseURL: "http://localhost:3117",
    viewport: { width: 1920, height: 1080 },
    colorScheme: "dark",
  },
  outputDir: "./screenshots",
  projects: [
    {
      name: "marketing",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
