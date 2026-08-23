import { z } from "zod";
import { GameIdSchema } from "../../games/ids";

export const TRACK_CONFIGURATION_VERSION = 1 as const;

function validCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export const TrackVenueIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/, "Use slash-separated lowercase venue segments");
const trackIdentityId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and hyphens");
export const TrackIdentityNodeSchema = z.object({
  id: trackIdentityId,
  name: z.string().trim().min(1),
});
export const CURRENT_TRACK_REVISION = "current";

export interface VenueRevisionPath {
  rootVenuePath: string;
  revisionPath: string;
}

/**
 * Splits SQLite venue path into its stable root venue and source revision.
 * A root-only path addresses current source revision.
 */
export function parseVenueRevisionPath(venuePath: string): VenueRevisionPath {
  const segments = TrackVenueIdSchema.parse(venuePath).split("/");
  const rootVenuePath = segments[0]!;
  return {
    rootVenuePath,
    revisionPath: segments.slice(1).join("/") || CURRENT_TRACK_REVISION,
  };
}

/** Browser-safe path components for one source revision directory. */
export function revisionDirectoryPathComponents(venuePath: string): string[] {
  const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venuePath);
  return ["venues", rootVenuePath, "revisions", ...revisionPath.split("/")];
}

/** Browser-safe path components for one canonical layout's source assets. */
export function canonicalTrackAssetPathComponents(venuePath: string, layoutSlug: string): string[] {
  return [...revisionDirectoryPathComponents(venuePath), "tracks", trackIdentityId.parse(layoutSlug)];
}

/** Splits one canonical layout ID into SQLite venue path and layout slug. */
export function parseCanonicalTrackId(canonicalTrackId: string): { venuePath: string; layoutSlug: string } {
  const segments = TrackVenueIdSchema.parse(canonicalTrackId).split("/");
  if (segments.length < 2) throw new Error(`Invalid canonical track ID ${JSON.stringify(canonicalTrackId)}`);
  const layoutSlug = trackIdentityId.parse(segments.pop()!);
  return {
    venuePath: TrackVenueIdSchema.parse(segments.join("/")),
    layoutSlug,
  };
}

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
  venue: TrackIdentityNodeSchema,
  subVenues: z.array(TrackIdentityNodeSchema).max(8),
  track: TrackIdentityNodeSchema,
  confirmation: TrackConfigurationConfirmationSchema.nullable(),
});

export type TrackConfiguration = z.infer<typeof TrackConfigurationSchema>;
export type TrackConfigurationConfirmation = z.infer<typeof TrackConfigurationConfirmationSchema>;
export type TrackIdentityNode = z.infer<typeof TrackIdentityNodeSchema>;

export function trackConfigurationVenueId(configuration: Pick<TrackConfiguration, "venue" | "subVenues">): string {
  return [configuration.venue.id, ...configuration.subVenues.map((node) => node.id)].join("/");
}

export function trackConfigurationCanonicalId(configuration: Pick<TrackConfiguration, "venue" | "subVenues" | "track">): string {
  return `${trackConfigurationVenueId(configuration)}/${configuration.track.id}`;
}
