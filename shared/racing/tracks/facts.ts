/**
 * Track facts: what the circuit IS. Game-agnostic, no fractions.
 *
 * Bundled registry splits each layout between:
 *
 *   track facts rows      — what circuit IS
 *   per-game geometry rows — where segments are in each simulator
 *
 * Facts carry turn numbers, turn names, named straights, groups, and layout
 * identity. They are game-agnostic and hold no fractions. Every game that
 * ships this layout is modelling the same real-world circuit, so the set of
 * turns is identical across games — only where each turn sits along the lap
 * differs, because each game digitises its own centerline.
 *
 * That is the whole invariant: classification is a property of the track,
 * geometry is a property of the (track, game) pair. A name never appears in a
 * geometry row, and a fraction never appears in facts.
 *
 * Geometry lives in `shared/racing/tracks/geometry.ts`; the keys that join the two in
 * `shared/racing/tracks/keys.ts`; the join itself in `shared/racing/tracks/curation/join.ts`.
 */

import { z } from "zod";

const trackFactId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and hyphens");

/** Validation contract for one numbered corner, including compound turn coverage. */
export const CornerFactSchema = z.object({
  number: z.number().int().positive(),
  covers: z.array(z.number().int().positive()).optional(),
  name: z.string(),
  direction: z.enum(["left", "right"]).optional(),
  group: z.string().optional(),
});

/** Validation contract for one named straight anchored after a turn. */
export const StraightFactSchema = z.object({
  after: z.number().int().positive(),
  name: z.string(),
  group: z.string().optional(),
});

/** Game-independent circuit classification and layout identity contract. */
export const TrackFactsSchema = z.object({
  slug: trackFactId,
  track: trackFactId,
  layout: trackFactId,
  layoutName: z.string().min(1),
  name: z.string().min(1),
  source: z.string().optional(),
  corners: z.array(CornerFactSchema),
  straights: z.array(StraightFactSchema).optional(),
});

/** One officially numbered corner. `number` plus `covers` is its identity. */
export type CornerFact = z.infer<typeof CornerFactSchema>;

/** A named gap between corners. Unnamed gaps get no entry — they're derived. */
export type StraightFact = z.infer<typeof StraightFactSchema>;

/** The facts file. No fractions, no per-game anything. */
export type TrackFacts = z.infer<typeof TrackFactsSchema>;

/** Turn numbers a corner fact occupies, sorted. */
export function cornerNumbers(c: CornerFact): number[] {
  return [c.number, ...(c.covers ?? [])].sort((a, b) => a - b);
}
