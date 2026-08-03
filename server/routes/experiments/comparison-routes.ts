import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../../shared/http/route-schemas";
import { getExperimentVersion } from "../../db/experiment-version-queries";
import { loadArmComparison } from "../../experiments/comparison/load";
import { OUTCOME_METRIC_IDS } from "../../experiments/comparison/metrics";
import { serializeComparison } from "../../experiments/comparison/presentation";

const ArmComparisonQuerySchema = z.object({
  a: z.coerce.number().int().positive(),
  b: z.coerce.number().int().positive(),
  metric: z.enum(OUTCOME_METRIC_IDS).default("lapTimeSec"),
});


export const experimentComparisonRoutes = new Hono()
  // GET /api/experiments/:id/arm-comparison?a=&b=&metric= — A/B significance
  // between two experiment arms (experiment_versions) on one outcome metric
  // (issue #120, Phase 2). Read-only, and deliberately so: the response's
  // `significance` says whether the difference is distinguishable from noise,
  // NOT whether the change was good. `experiment_versions.verdict` stays a human call
  // and nothing on this path writes it.
  //
  // Lap curation is the metric's policy, not the session's: lap time gets the
  // fastest-N pool, the variance metrics get every eligible lap (see
  // server/experiments/comparison/metrics.ts).
  .get("/api/experiments/:id/arm-comparison",
    zValidator("param", IdParamSchema),
    zValidator("query", ArmComparisonQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { a, b, metric } = c.req.valid("query");
      if (a === b) return c.json({ error: "Pick two different arms to compare" }, 400);

      for (const versionId of [a, b]) {
        const test = await getExperimentVersion(versionId);
        if (!test) return c.json({ error: `Tuning test ${versionId} not found` }, 404);
        if (test.experimentId !== id) return c.json({ error: `Tuning test ${versionId} is not in this session` }, 400);
      }

      const comparison = await loadArmComparison(id, a, b, metric);
      return c.json(serializeComparison(comparison));
    }
  );
