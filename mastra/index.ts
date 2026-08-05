/**
 * Mastra instance for both the Studio observability UI and the running server.
 *
 *   Dev:     mounted in-process onto the RaceIQ Hono app under `/studio-api`
 *            (see server/runtime/dev-studio.ts). `bun run mastra:studio` serves the
 *            Studio UI on :3000 and reads this API over HTTP — the server is the
 *            sole DuckDB writer, so there is no second-process file lock.
 *   Runtime: imported by `server/routes/laps/chat-routes.ts` to call agents.
 *   Prod:    never imported (NODE_ENV-gated) — DuckDB stays out of raceiq.exe.
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
import { resolve } from "node:path";
import { lapAnalystAgent } from "./agents/lap-analyst";
import { lapChatAgent } from "./agents/lap-chat";
import { compareEngineerAgent } from "./agents/compare-engineer";
import { compareChatAgent } from "./agents/compare-chat";
import { setupEngineerAgent } from "./agents/setup-engineer";
import { driverProfilerAgent } from "./agents/driver-profiler";
import { driverCoachAgent } from "./agents/driver-coach";
import { compareAnalyseWorkflow } from "./workflows/compare-analyse";
import { setupEngineerTurnWorkflow } from "./workflows/setup-engineer-turn";
import { scorerRegistry } from "./evals";

/**
 * DuckDB observability store — anchored on an absolute path (DATA_DIR or
 * <cwd>/data) so it is stable regardless of the process cwd. Only ONE process
 * ever opens it read-write: the RaceIQ dev server (DuckDB is single-writer, and
 * its Metrics tab is OLAP-only so LibSQL can't substitute). `mastra studio`
 * does NOT open this file — it reads the server's in-process Mastra API over
 * HTTP (see server/runtime/dev-studio.ts), which is what keeps the two from deadlocking.
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
    "setup-engineer": setupEngineerAgent,
    "driver-profiler": driverProfilerAgent,
    "driver-coach": driverCoachAgent,
  },
  workflows: {
    "compare-analyse": compareAnalyseWorkflow,
    "setup-engineer-turn": setupEngineerTurnWorkflow,
  },
  scorers: scorerRegistry,
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
export const getSetupEngineerAgent = () => mastra.getAgent("setup-engineer");
