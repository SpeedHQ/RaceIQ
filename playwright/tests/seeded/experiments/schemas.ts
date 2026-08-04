import { z } from "zod";

export const ExperimentSchema = z.object({ id: z.number() });

export const ImportLapsResponseSchema = z.object({
  importedIds: z.array(z.number()),
});
