import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(js|jsx|ts|tsx)"],
  addons: ["storybook/viewport", "@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal(config) {
    return mergeConfig(config, {
      envDir: path.resolve(__dirname, "../.."),
      envPrefix: ["VITE_", "RACEIQ_"],
      resolve: {
        alias: {
          "@": path.resolve(__dirname, "../src"),
          "@shared": path.resolve(__dirname, "../../shared"),
        },
      },
    });
  },
};

export default config;
