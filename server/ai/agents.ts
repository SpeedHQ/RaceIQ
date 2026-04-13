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
import { lapChatAgent as rawLapChatAgent } from "../../mastra/agents/lap-chat";
import { compareEngineerAgent as rawCompareEngineerAgent } from "../../mastra/agents/compare-engineer";
import { compareChatAgent as rawCompareChatAgent } from "../../mastra/agents/compare-chat";

type LapChatAgent = typeof rawLapChatAgent;
type CompareEngineerAgent = typeof rawCompareEngineerAgent;
type CompareChatAgent = typeof rawCompareChatAgent;

let lapChatAgent: LapChatAgent = rawLapChatAgent;
let compareEngineerAgent: CompareEngineerAgent = rawCompareEngineerAgent;
let compareChatAgent: CompareChatAgent = rawCompareChatAgent;

if (process.env.NODE_ENV !== "production") {
  const { mastra } = await import("../../mastra");
  lapChatAgent = mastra.getAgent("lap-chat") as unknown as LapChatAgent;
  compareEngineerAgent = mastra.getAgent("compare-engineer") as unknown as CompareEngineerAgent;
  compareChatAgent = mastra.getAgent("compare-chat") as unknown as CompareChatAgent;
}

export { lapChatAgent, compareEngineerAgent, compareChatAgent };
