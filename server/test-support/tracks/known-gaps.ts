/**
 * Sanctioned gaps in track segment generation, shared by
 * test/track-segment-generate.test.ts and test/track-turn-counts.test.ts so the
 * two cannot disagree about what is known-broken.
 *
 * Shrink-only contract: every entry is asserted to STILL be broken. Fixing the
 * underlying centerline makes the corresponding test fail until the entry is
 * deleted. Adding an entry means something regressed and needs a reason here.
 */

/**
 * `slug/gameId` pairs whose centerline under-detects corner regions so badly the
 * curated name list cannot align at any lap rotation. All ac-evo: the name lists
 * align cleanly on ACC/F1/FM, so the defect is ac-evo centerline quality —
 * regrouping the names to suit ac-evo would break the other games.
 *
 * watkins-glen/fm-2023 is the inverse: Forza's centerline over-detects (14
 * regions for 10 named corners, 9 units) because the Esses complex is digitised
 * as separate kinks there. Segment generation is a *fallback* for tracks with no
 * curated geometry, so a mis-detect on a track that already ships curated
 * geometry costs nothing — not worth re-curating the shared name list around one
 * game's centerline.
 */
export const KNOWN_ALIGNMENT_GAPS = new Set<string>(["watkins-glen/fm-2023"]);

/**
 * `slug/gameId` pairs that align, but too loosely to persist (cost >= 1), so the
 * committed geometry stays whatever the migration produced from that game's own
 * data.
 *
 * `nordschleife` folded three games onto one slug, but its curated name list was
 * authored against ACC's centerline: 60 corners, starting at the ACC start line.
 * Forza's Nordschleife is the same tarmac digitised into 69 corners from a
 * different lap origin (rotation offset 88) in a mirrored frame, so the list
 * cannot place itself on it. Forza's committed geometry came from Forza's own
 * legacy segmentation and is correct; only regeneration can't reproduce it.
 *
 * TODO(follow-up PR): reconcile shared/data/tracks/meta/nordschleife.json to the
 * 69-corner segmentation and delete this.
 */
export const KNOWN_FUZZY_ALIGNMENTS = new Set(["nordschleife/fm-2023"]);

