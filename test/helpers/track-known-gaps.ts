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
 * Empty for now — laguna-seca/road-atlanta/sebring were fixed by declaring
 * their genuine per-corner ac-evo gaps in KNOWN_TURN_GAPS below (T1, T6/T12/T18)
 * and grouping the corners ac-evo's centerline fuses that the others split
 * (see shared/tracks/corner-names/road-atlanta.json, sebring.json). Kept as an
 * exported Set so a track that genuinely can't align at all has somewhere to go.
 */
export const KNOWN_ALIGNMENT_GAPS = new Set<string>([]);

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
 * TODO(follow-up PR): reconcile shared/tracks/corner-names/nordschleife.json to
 * the 69-corner segmentation and delete this.
 */
export const KNOWN_FUZZY_ALIGNMENTS = new Set(["nordschleife/fm-2023"]);

/**
 * `<slug> T<number> <gameId>` — an *optional* corner that some games' centerlines
 * show and this one doesn't. `optional` means "may match nothing", so these fail
 * silently, but a corner detected on one game is real and its absence on another
 * is a detector gap, not a track that lacks the corner.
 *
 * The big-radius cases (Curva Grande, Courbe Paul Frère on F1) are fixed: the
 * loose second pass in detectCornerRegions finds sweeps sitting on the strict
 * entry threshold. What remains is NOT a threshold problem — do not try:
 *
 * ACC entries: historically ACC's "centerline" was the fastlane.ai RACING LINE,
 * not the track centre. A racing line apexes and cuts, so these corners were
 * straightened or fused into a neighbour rather than faintly detected. Loosening
 * thresholds makes it worse (at 1/1400 Brands Hatch's Dingle Dell neighbours fuse
 * into one), because the loose pass only fills gaps and there is no gap here. The
 * fix (issue #98) is the true centre from shared/tracks/acc/<slug>-boundaries.json
 * via scripts/acc-centerline-from-boundaries.ts; the migrated tracks are already
 * gone from this list, the rest need per-track name-list re-curation.
 *
 * ac-evo entries: same class as KNOWN_ALIGNMENT_GAPS above — the ac-evo
 * centerline aligns overall but under-detects these individual corners, which
 * ACC's true-centre centerline does find.
 */
export const KNOWN_TURN_GAPS = new Set([
  "brands-hatch T7 acc", // Dingle Dell — pending true-centre migration
  "brands-hatch T7 ac-evo",
  "catalunya T6 acc",
  "catalunya T14 f1-2025",
  "catalunya T14 fm-2023",
  "imola T8 ac-evo",
  "imola T13 ac-evo",
  "laguna-seca T1 ac-evo",
  "sebring T6 ac-evo",
  "sebring T12 ac-evo",
  "sebring T18 ac-evo",
  "silverstone T5 acc", // Aintree — pending true-centre migration
  "spa T16 ac-evo",
  "zandvoort T13 acc", // pending true-centre migration
]);
