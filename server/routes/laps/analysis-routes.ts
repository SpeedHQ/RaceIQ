import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { IdParamSchema } from "@shared/platform/http/route-schemas";
import { deleteAnalysis } from "../../db/analysis-queries";
import { generateLapAnalysis } from "../../ai/generate-lap-analysis";
import { toClientAiError } from "../../ai/provider-error";
import { beginAnalysisRun, finishAnalysisRun, getAnalysisRun } from "../../ai/analysis-run-registry";
import { AnalyseQuerySchema } from "./support";

const analysisErrorStatus = (error: string, decision: Awaited<ReturnType<typeof generateLapAnalysis>>["decision"]): 400 | 404 | 422 =>
  error === "Lap not found" ? 404 : decision?.status === "ineligible" || decision?.status === "unknown" ? 422 : 400;
const analysisRunKey = (lapId: number) => `lap-analysis:${lapId}`;

export const analysisRoutes = new Hono()
  .get("/api/laps/:id/analyse/status", zValidator("param", IdParamSchema), (c) => {
    const { id } = c.req.valid("param");
    const run = getAnalysisRun(analysisRunKey(id));
    if (!run) return c.json({ status: "none" as const });
    if (run.status === "active") return c.json({ status: "active" as const });
    if (run.status === "failed") {
      return c.json({ status: "failed" as const, error: run.error ?? "Analysis failed" });
    }
    return c.json({ status: "finished" as const });
  })
  .post("/api/laps/:id/analyse", zValidator("param", IdParamSchema), zValidator("query", AnalyseQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { regenerate, cacheOnly } = c.req.valid("query");

    // Cache-only requests and normal non-regenerate requests never start
    // another model call. The generation service also validates JSON before
    // serving a cached row, so stale malformed rows do not get stuck.
    if (!regenerate || cacheOnly) {
      const cached = await generateLapAnalysis(id, { cacheOnly: true });
      if (cached.error) {
        const status = analysisErrorStatus(cached.error, cached.decision);
        return c.json({ error: cached.error, decision: cached.decision }, status);
      }
      if (cacheOnly || cached.cached) return c.json(cached);
    }

    // Validate lap and provider configuration before reserving the detached
    // run. This keeps missing-lap errors synchronous and prevents a run
    // status from being left active when no model can be selected.
    const preflight = await generateLapAnalysis(id, {
      regenerate: true,
      cacheOnly: true,
      preflight: true,
    });
    if (preflight.error) {
      const status = analysisErrorStatus(preflight.error, preflight.decision);
      return c.json({ error: preflight.error, decision: preflight.decision }, status);
    }

    const key = analysisRunKey(id);
    const run = beginAnalysisRun(key);
    if (!run) return c.json({ status: "active" as const }, 409);

    const encoder = new TextEncoder();
    const writeEvent = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) => {
      try {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch {
        // Client disconnected; detached generation still finishes and caches.
      }
    };

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const keepAlive = setInterval(() => writeEvent(controller, { type: "ping" }), 200_000);
        try {
          const result = await generateLapAnalysis(id, { regenerate: true });
          if (result.error) {
            writeEvent(controller, { type: "error", message: result.error });
            finishAnalysisRun(key, result.error);
          } else {
            writeEvent(controller, {
              type: "result",
              analysis: result.analysis,
              cached: result.cached,
              usage: result.usage,
              cornerFracs: result.cornerFracs,
              hasTune: result.hasTune,
            });
            finishAnalysisRun(key);
          }
        } catch (error) {
          const aiError = toClientAiError(error);
          console.error("[AI] Analysis failed:", aiError.message);
          writeEvent(controller, { type: "error", ...aiError });
          finishAnalysisRun(key, aiError.message);
        } finally {
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            // Stream may already be closed after client disconnect.
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
      },
    });
  })
  .delete("/api/laps/:id/analyse", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      await deleteAnalysis(id);
    } catch (error) {
      console.error("[AI] Failed to clear analysis:", error);
    }
    return c.json({ ok: true });
  });
