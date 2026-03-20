import { defineConfig } from "drizzle-kit";

const DATA_DIR = process.env.DATA_DIR ?? "./data";

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `${DATA_DIR}/forza-telemetry.db`,
  },
});
