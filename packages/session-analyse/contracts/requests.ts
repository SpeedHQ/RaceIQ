import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";

export const ReviewLapsQuerySchema = z.object({
  gameId: GameIdSchema,
  sessionId: z.coerce.number().int().positive().optional(),
  trackId: z.string().min(1).optional(),
  carId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
}).refine((value) => value.sessionId != null || (value.trackId != null && value.carId != null), {
  message: "sessionId or trackId and carId required",
});

export const ReviewLineSpreadQuerySchema = z.object({
  gameId: GameIdSchema,
  sessionId: z.coerce.number().int().positive(),
  lapIds: z.string().min(1).transform((value) => value.split(",").map(Number)).refine((ids) => ids.length >= 1 && ids.length <= 5 && ids.every((id) => Number.isInteger(id) && id > 0) && new Set(ids).size === ids.length, "lapIds must contain 1–5 unique positive IDs"),
});
