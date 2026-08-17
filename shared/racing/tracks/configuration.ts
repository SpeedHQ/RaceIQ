import { z } from "zod";
import { GameIdSchema } from "../../games/ids";

export const TRACK_CONFIGURATION_VERSION = 1 as const;

function validCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export const TrackVenueIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/, "Use slash-separated lowercase venue segments");

export const TrackConfigurationConfirmationSchema = z.object({
  confirmedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Confirmation date must use YYYY-MM-DD")
    .refine(validCalendarDate, "Confirmation date must be valid"),
  confirmedBy: z.string().trim().min(1),
  commitId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i, "Commit ID must be a 7-64 digit hexadecimal hash")
    .optional(),
});

export const TrackConfigurationSchema = z.object({
  version: z.literal(TRACK_CONFIGURATION_VERSION),
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
  venueId: TrackVenueIdSchema,
  confirmation: TrackConfigurationConfirmationSchema.nullable(),
});

export type TrackConfiguration = z.infer<typeof TrackConfigurationSchema>;
export type TrackConfigurationConfirmation = z.infer<typeof TrackConfigurationConfirmationSchema>;
