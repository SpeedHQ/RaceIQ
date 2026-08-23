import { z } from "zod";

import { GameIdSchema } from "../../../shared/games/ids";
import { getCatalogDisplayName, normalizePacketSetup, topCatalogReferences } from "../../ai/f1-setup-catalog";
import { resolveLapF1Setup } from "../../ai/f1-setup-identity";

export const CompareParamsSchema = z.object({
  id1: z.string().transform((val) => parseInt(val, 10)),
  id2: z.string().transform((val) => parseInt(val, 10)),
});

export const LapsQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
});

export const AnalyseQuerySchema = z.object({
  regenerate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  cacheOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export const ChatHistoryQuerySchema = z.object({
  gen: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().finite().int().positive().safe())
    .optional(),
});

export const FindingGenerationBackfilling = {
  error: "Finding generation is backfilling",
  status: "backfilling" as const,
  retryable: true,
};

export const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int()),
});

export const IbtImportTokenSchema = z.object({
  token: z.string().uuid(),
});
export const OwnershipSchema = z.enum(["mine", "others"]);
export const IbtCommitSchema = IbtImportTokenSchema.extend({ ownership: OwnershipSchema });
/** Comma-separated id list in a query string → number[] (ignores junk/empties). */
const IdListSchema = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );

export const ExportZipQuerySchema = z.object({
  ids: IdListSchema,
  sessionIds: IdListSchema,
});

export const ChatBodySchema = z.object({
  messages: z.array(z.any()),
});

/**
 * Build the "F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS" block appended to
 * the analyst prompt for F1 laps. The same data the
 * `compare-f1-setup-to-catalog` tool returns, but inline so local models
 * (Gemma 4) can answer in one shot instead of looping tool calls.
 */
export function buildF1SetupReferenceBlock(carSetupJson: string | undefined, trackOrdinal: number): string {
  const setup = resolveLapF1Setup(carSetupJson);
  if (!setup || trackOrdinal < 0) return "";
  const current = normalizePacketSetup(setup as unknown as Record<string, unknown>);
  const refs = topCatalogReferences(trackOrdinal, 5, current);
  if (refs.length === 0) return "";

  const lines: string[] = [];
  lines.push(`\n\n--- F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS (${getCatalogDisplayName(trackOrdinal) ?? "this track"}) ---`);
  lines.push("Use this data to populate setup[]. Cite rank/team/author per entry. Only propose steps within the step-cap rules.");
  lines.push("");
  lines.push("Current setup:");
  for (const [k, v] of Object.entries(current)) lines.push(`  ${k}: ${v}`);
  for (const r of refs) {
    lines.push("");
    lines.push(`Rank ${r.rank} — ${r.team} / ${r.author} — ${r.lapTime} (${r.weather}, ${r.inputDevice}):`);
    const deltas = Object.entries(r.delta ?? {});
    if (deltas.length === 0) {
      lines.push("  (identical to current setup)");
    } else {
      for (const [k, v] of deltas) {
        const sign = (v as number) > 0 ? "+" : "";
        lines.push(`  ${k}: ${current[k]} → ${(r.setup as Record<string, number>)[k]} (${sign}${v})`);
      }
    }
  }
  return lines.join("\n");
}
