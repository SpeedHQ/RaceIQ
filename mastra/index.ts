/**
 * Mastra instance for both the Studio playground and the running server.
 *
 *   Studio:  bun run mastra:dev → http://localhost:4111
 *   Runtime: imported by `server/routes/lap-routes.ts` to call agents.
 *
 * Each agent has its own file under `mastra/agents/` for clarity. Add a new
 * agent by creating a file there and registering it below.
 */
import { Mastra } from "@mastra/core";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { PinoLogger } from "@mastra/loggers";
import { Observability, DefaultExporter } from "@mastra/observability";
import { resolve } from "path";
import { lapAnalystAgent } from "./agents/lap-analyst";
import { lapChatAgent } from "./agents/lap-chat";
import { compareEngineerAgent } from "./agents/compare-engineer";
import { compareChatAgent } from "./agents/compare-chat";

/**
 * DuckDB observability store — anchored on an absolute path (DATA_DIR or
 * <cwd>/data) so the running RaceIQ server and the `mastra dev` Studio
 * process write to the SAME file. Without this, each process creates its
 * own mastra.duckdb in whatever cwd it happens to have, so Studio never
 * sees the traces from the app's real API calls.
 */
const observabilityDuckDbPath =
  `${process.env.DATA_DIR ?? resolve(process.cwd(), "data")}/mastra-observability.duckdb`;

/**
 * LibSQL handles the default Mastra metadata (agents, evals, workflows) and
 * DuckDB owns the `observability` domain so Studio's Logs/Traces tabs work —
 * LibSQL does not implement `listLogs` on its observability store.
 */
export const mastra = new Mastra({
  agents: {
    "lap-analyst": lapAnalystAgent,
    "lap-chat": lapChatAgent,
    "compare-engineer": compareEngineerAgent,
    "compare-chat": compareChatAgent,
  },
  storage: new MastraCompositeStore({
    id: "raceiq-composite",
    default: new LibSQLStore({
      id: "mastra-storage",
      url: ":memory:",
    }),
    domains: {
      observability: await new DuckDBStore({ path: observabilityDuckDbPath }).getStore("observability"),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "raceiq",
        exporters: [new DefaultExporter()],
      },
    },
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});

// Convenience getters for the rest of the codebase. These are typed against
// the Mastra registry so callers get back fully-typed Agent instances.
export const getLapAnalystAgent = () => mastra.getAgent("lap-analyst");
export const getLapChatAgent = () => mastra.getAgent("lap-chat");
export const getCompareEngineerAgent = () => mastra.getAgent("compare-engineer");
export const getCompareChatAgent = () => mastra.getAgent("compare-chat");
