/**
 * Dev-only: mount the Mastra API onto the RaceIQ Hono app so `mastra studio`
 * can read Metrics / Logs / Traces of the app's REAL agent calls over HTTP.
 *
 * Why in-process instead of a second `mastra dev`:
 *   The Studio observability store is DuckDB — required because the Metrics tab
 *   is OLAP-only (LibSQL/Postgres are unsupported for metrics). DuckDB is a
 *   single-writer store: if two processes open the same file read-write (the
 *   running server AND a separate `mastra dev`), the second hits a file lock and
 *   cannot connect. So the RaceIQ server is the SOLE DuckDB writer here — agents
 *   execute in-process, so per-request API keys / provider / model selection keep
 *   working exactly as before — and `mastra studio` is a static UI that only
 *   READS this API over HTTP. One writer, no lock, full observability.
 *
 * Prod excludes this entirely: index.ts guards on NODE_ENV and never imports
 * this module, so @mastra/hono and mastra/index.ts (which pulls the DuckDB native
 * addon) stay out of raceiq.exe. This is the same sanctioned dynamic-import
 * boundary used by server/ai/agents.ts.
 */
import type { Hono } from "hono";
import { MastraServer } from "@mastra/hono";
import { scoreTracesWorkflow } from "@mastra/core/evals/scoreTraces";
import { mastra } from "../../mastra";

/**
 * Distinct from RaceIQ's own `/api/*` routes so Mastra's built-in endpoints
 * (agents, observability, logs, metrics) never collide. Keep in sync with the
 * `mastra:studio` script's `--server-api-prefix` and the index.ts dispatch.
 */
export const STUDIO_API_PREFIX = "/studio-api";

export async function mountStudioServer(app: Hono): Promise<void> {
  // HonoApp is a structural interface (use/get/post/...); the concrete chained
  // Hono type from routes/index.ts satisfies it but TS can't prove it through generics.
  const server = new MastraServer({ app: app as never, mastra, prefix: STUDIO_API_PREFIX });
  await server.init();

  // Register the internal batch-scoring-traces workflow. Studio's "Score
  // traces" action calls core's `scoreTraces()`, which looks this workflow up
  // via `mastra.__getInternalWorkflow("__batch-scoring-traces")`. The stock
  // `mastra dev` playground server registers it at boot; our in-process
  // MastraServer mount does not, so we register it here or the button 404s
  // ("Workflow with id __batch-scoring-traces not found"). `__`-prefixed
  // internal API — revisit if a future @mastra/core bump changes it.
  (mastra as unknown as {
    __registerInternalWorkflow: (wf: typeof scoreTracesWorkflow) => void;
  }).__registerInternalWorkflow(scoreTracesWorkflow);
  console.log(
    `[Studio] Mastra API mounted at ${STUDIO_API_PREFIX} — run 'bun run mastra:studio' to inspect traces`,
  );
}
