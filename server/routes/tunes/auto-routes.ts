import { zValidator } from "@hono/zod-validator";
import { existsSync, readFileSync, realpathSync } from "fs";
import { Hono } from "hono";
import { resolve, sep } from "path";
import { z } from "zod";

import { requestTuneIntents } from "../../ai/tune-intent";
import { symptomsToIntents } from "../../ai/tune-recommend";
import { telemetryToSymptoms } from "../../ai/tune-symptoms";
import { writeSetupFile } from "../../ai/tune-writer";
import { detectCorners } from "../../lap-analysis/corners";
import { getLapById } from "../../db/lap-read-queries";
import { getSetupsBaseDir } from "../../setups/file-guard";
import { applyIntents } from "../../setups/rules/engine";

const AutoTuneSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  stintId: z.number().int(),
  filePath: z.string().min(1),
  trackName: z.string().optional(),
  preview: z.boolean().optional().default(false),
  saveAsName: z.string().min(1).max(120).optional(),
  overwrite: z.boolean().optional().default(false),
  engine: z.enum(["rules", "llm"]).optional().default("rules"),
  driverNotes: z.string().max(500).optional(),
});

export const tuneAutoRoutes = new Hono()
  .post(
    "/api/tunes/auto",
    zValidator("json", AutoTuneSchema),
    async (c) => {
      const body = c.req.valid("json");

      const lap = await getLapById(body.stintId);
      if (!lap) return c.json({ error: "Stint not found" }, 404);
      const packets = lap.telemetry;
      if (packets.length < 30) {
        return c.json({ error: "Not enough telemetry to analyse this stint" }, 400);
      }

      const hasSetup = !!body.filePath;
      let baseDir: string | null = null;
      let realPath: string | null = null;
      let sourceSetup: any = null;
      let carModel: string | undefined;

      if (hasSetup) {
        baseDir = await getSetupsBaseDir(body.gameId);
        if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);
        const absPath = resolve(body.filePath!);
        if (!existsSync(absPath)) return c.json({ error: "Setup file not found" }, 404);

        let realBase: string;
        try {
          realPath = realpathSync(absPath);
          realBase = realpathSync(resolve(baseDir));
        } catch (err: any) {
          if (err?.code === "ENOENT") return c.json({ error: "Setup file not found" }, 404);
          return c.json({ error: `Read failed: ${err.message}` }, 500);
        }
        if (!(realPath + sep).startsWith(realBase + sep)) {
          return c.json({ error: "Path must be inside the Setups folder" }, 400);
        }
        if (!realPath.toLowerCase().endsWith(".json")) {
          return c.json({ error: "Only .json setup files can be auto-tuned" }, 400);
        }

        try { sourceSetup = JSON.parse(readFileSync(realPath, "utf-8")); }
        catch (err: any) { return c.json({ error: `Invalid setup JSON: ${err.message}` }, 400); }

        const relSegments = realPath.slice(realBase.length + 1).split(sep);
        if (relSegments.length >= 2) carModel = relSegments[0];
      }

      const corners = detectCorners(packets);
      const symptoms = telemetryToSymptoms(packets, corners);
      const rulesIntents = symptomsToIntents(symptoms, body.gameId, { driverNotes: body.driverNotes });

      let intents;
      let model: string;
      let llmFreeIntents: typeof rulesIntents | null = null;
      if (body.engine === "llm") {
        try {
          const res = await requestTuneIntents(body.gameId, symptoms, body.trackName, carModel);
          intents = res.intents.intents;
          model = res.model;
        } catch (err: any) {
          return c.json({ error: err?.message ?? "AI request failed" }, 502);
        }
        llmFreeIntents = rulesIntents;
      } else {
        intents = rulesIntents;
        model = "rules";
      }

      if (!hasSetup) {
        return c.json({
          symptoms, intents, rulesIntents: llmFreeIntents, applied: [], skipped: [], model,
          written: null, preview: true, hasSetup: false,
        });
      }

      const { setup, applied, skipped } = applyIntents(body.gameId, sourceSetup, intents, carModel);
      let written = null;
      if (!body.preview) {
        try {
          written = writeSetupFile(baseDir!, realPath!, setup, body.saveAsName, body.overwrite);
        } catch (err: any) {
          return c.json({ error: `Write failed: ${err.message}` }, 500);
        }
      }

      return c.json({ symptoms, intents, rulesIntents: llmFreeIntents, applied, skipped, model, written, preview: !!body.preview, hasSetup: true });
    },
  );
