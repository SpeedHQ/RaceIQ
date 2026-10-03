import { defineConfig } from "drizzle-kit";

const DATA_DIR = process.env.DATA_DIR ?? "./data";

export default defineConfig({
  schema: "@raceiq/backend-core/db/schema",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `${DATA_DIR}/app.db`,
  },
  tablesFilter: ["!schema_migrations"],
});
