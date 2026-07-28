/**
 * Agent references for the server runtime.
 *
 * Why this indirection exists:
 *
 *   - In PRODUCTION (`raceiq.exe`) we want to keep the binary small. The full
 *     Mastra instance in `mastra/index.ts` pulls in @mastra/duckdb,
 *     @mastra/loggers, and @mastra/observability which are only useful for the
 *     `mastra dev` Studio UI. Those packages live in devDependencies and the
 *     prod build sets `NODE_ENV=production`, so the `if (IS_DEV)` branch below
 *     is tree-shaken out and `mastra/index.ts` is never reached.
 *
 *   - In DEVELOPMENT (`bun run dev:server`) we DO want the agents to be the
 *     ones registered inside the full Mastra instance — that's what makes
 *     their calls show up as traces in Studio's observability tab. So the dev
 *     branch resolves each agent via `mastra.getAgent(...)`, which shares the
 *     DuckDB observability store with `bun run mastra:dev` (both anchor on the
 *     same absolute `data/mastra-observability.duckdb` path).
 *
 * Note: the `await import("../../mastra")` is a deliberate exception to the
 * project's "no dynamic imports" rule — it's the only way to keep the full
 * Mastra instance out of the prod bundle while still letting the dev server
 * emit traces.
 */
import { resolve } from "path";
import type { ExperimentFocus } from "../../shared/experiment-focus";
import { lapAnalystAgent as rawLapAnalystAgent } from "../../mastra/agents/lap-analyst";
import { lapChatAgent as rawLapChatAgent } from "../../mastra/agents/lap-chat";
import { compareEngineerAgent as rawCompareEngineerAgent } from "../../mastra/agents/compare-engineer";
import { compareChatAgent as rawCompareChatAgent } from "../../mastra/agents/compare-chat";
import { setupEngineerAgent as rawSetupEngineerAgent } from "../../mastra/agents/setup-engineer";
import { driverProfilerAgent as rawDriverProfilerAgent } from "../../mastra/agents/driver-profiler";
import { driverCoachAgent as rawDriverCoachAgent } from "../../mastra/agents/driver-coach";

type LapAnalystAgent = typeof rawLapAnalystAgent;
type LapChatAgent = typeof rawLapChatAgent;
type CompareEngineerAgent = typeof rawCompareEngineerAgent;
type CompareChatAgent = typeof rawCompareChatAgent;
type SetupEngineerAgent = typeof rawSetupEngineerAgent;
type DriverProfilerAgent = typeof rawDriverProfilerAgent;
type DriverCoachAgent = typeof rawDriverCoachAgent;

export function isMastraSignalMigrationRequiredError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("MASTRA_STORAGE_DUCKDB_MIGRATION_REQUIRED_SIGNAL_TABLES") ||
    err.message.includes("MIGRATION REQUIRED: DuckDB observability signal tables need signal IDs")
  );
}

let lapAnalystAgent: LapAnalystAgent = rawLapAnalystAgent;
let lapChatAgent: LapChatAgent = rawLapChatAgent;
let compareEngineerAgent: CompareEngineerAgent = rawCompareEngineerAgent;
let compareChatAgent: CompareChatAgent = rawCompareChatAgent;
let setupEngineerAgent: SetupEngineerAgent = rawSetupEngineerAgent;
let driverProfilerAgent: DriverProfilerAgent = rawDriverProfilerAgent;
let driverCoachAgent: DriverCoachAgent = rawDriverCoachAgent;

if (process.env.NODE_ENV !== "production") {
  try {
    const { mastra } = await import("../../mastra");
    lapAnalystAgent = mastra.getAgent("lap-analyst") as unknown as LapAnalystAgent;
    lapChatAgent = mastra.getAgent("lap-chat") as unknown as LapChatAgent;
    compareEngineerAgent = mastra.getAgent("compare-engineer") as unknown as CompareEngineerAgent;
    compareChatAgent = mastra.getAgent("compare-chat") as unknown as CompareChatAgent;
    setupEngineerAgent = mastra.getAgent("setup-engineer") as unknown as SetupEngineerAgent;
    driverProfilerAgent = mastra.getAgent("driver-profiler") as unknown as DriverProfilerAgent;
    driverCoachAgent = mastra.getAgent("driver-coach") as unknown as DriverCoachAgent;
  } catch (err) {
    if (isMastraSignalMigrationRequiredError(err)) {
      const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
      console.warn(
        `[AI] Mastra observability migration required at ${dataDir}/mastra-observability.duckdb. ` +
          `Run 'bun run mastra:migrate'. Falling back to non-observable agents for this process.`,
      );
    } else {
      throw err;
    }
  }
}

/**
 * Which specialist answers a session turn.
 *
 * The experiment's focus column decides — a switch, not a coordinator agent
 * inferring a route the driver already set with the workspace switcher. Kept
 * here rather than inline in the chat route so the mapping is testable and has
 * exactly one definition.
 */
export function sessionAgentForFocus(focus: ExperimentFocus) {
  return focus === "driver" ? driverCoachAgent : setupEngineerAgent;
}

export {
  lapAnalystAgent,
  lapChatAgent,
  compareEngineerAgent,
  compareChatAgent,
  setupEngineerAgent,
  driverProfilerAgent,
  driverCoachAgent,
};
