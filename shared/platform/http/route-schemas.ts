import { z } from "zod";
import { GameIdSchema } from "../../games/ids";

/** Path param `:id` — coerces to integer; a non-numeric id is rejected (400)
 *  rather than becoming NaN and reaching a DB lookup (500). */
export const IdParamSchema = z.object({
  id: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), "id must be an integer"),
});

/** Native car and track path identities stay strings, including layout tuples. */
export const CarIdParamSchema = z.object({
  carId: z.string().min(1),
});

export const TrackIdParamSchema = z.object({
  trackId: z.string().min(1),
});

/** Common `?gameId=` query param */
export const GameIdQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
});

const parseIntParam = (name: "id" | "versionId") =>
  z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), `${name} must be an integer`);

/** Path params `:id/:versionId` for experiment-version routes. */
export const IdVersionParamSchema = z.object({
  id: parseIntParam("id"),
  versionId: parseIntParam("versionId"),
});
