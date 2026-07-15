/**
 * Named corner/straight segments for known tracks.
 * Fractions are relative to the track outline (0 = start/finish, 1 = full lap).
 * These override auto-detected segments for a much better user experience.
 *
 * To calibrate: use POST /api/tracks/:id/recompute-outline?lapId=N to set a
 * clean single-lap outline, then inspect curvature peaks to determine fractions.
 */

export interface NamedSegment {
  type: "corner" | "straight";
  name: string;
  direction?: "left" | "right";
  startFrac: number;
  endFrac: number;
  /** Official turn numbers covered by this section (corners only). */
  numbers?: number[];
  /**
   * Sections that are one physical piece of track split into two segments —
   * the start/finish straight, which the line cuts into the lap's first and
   * last segment. Both halves share this key so consumers can label the
   * straight once instead of twice.
   */
  group?: string;
}

// Keyed by the corner-name list's `circuit` field (nameList.circuit), which is
// what track-segment-generate consults to skip detection. For most tracks this
// equals the tracks.csv name, but not always (e.g. Sebring's csv name is
// "Sebring International" while its circuit label is "Sebring International Raceway").
export const namedSegments: Record<string, NamedSegment[]> = {
  // Spa-Francorchamps — 7.004km GP circuit
  // Calibrated from lap 1337 telemetry (13958 pts, 6924m)
  // Reference: https://en.wikipedia.org/wiki/Circuit_de_Spa-Francorchamps
  "Circuit de Spa-Francorchamps": [
    // T1: La Source hairpin — peak at ~4.5% (264m)
    { type: "corner",   name: "La Source",        direction: "right", startFrac: 0.000, endFrac: 0.065 },
    // S1: downhill to Eau Rouge
    { type: "straight", name: "S1",                                   startFrac: 0.065, endFrac: 0.090 },
    // T2-4: Eau Rouge / Raidillon complex
    { type: "corner",   name: "Eau Rouge",        direction: "left",  startFrac: 0.090, endFrac: 0.130 },
    // S2: Kemmel straight — long flat-out section
    { type: "straight", name: "Kemmel",                               startFrac: 0.130, endFrac: 0.260 },
    // T5-6: Les Combes chicane — peaks at ~30% (2321m) and ~32% (2435m)
    { type: "corner",   name: "Les Combes",       direction: "right", startFrac: 0.260, endFrac: 0.340 },
    // S3: short straight
    { type: "straight", name: "S3",                                   startFrac: 0.340, endFrac: 0.365 },
    // T7: Malmedy — peak at ~40.5% (2906m)
    { type: "corner",   name: "Malmedy",          direction: "right", startFrac: 0.365, endFrac: 0.420 },
    // S4: short downhill
    { type: "straight", name: "S4",                                   startFrac: 0.420, endFrac: 0.435 },
    // T8: Rivage hairpin — peak at ~45.4% (3137m)
    { type: "corner",   name: "Rivage",           direction: "right", startFrac: 0.435, endFrac: 0.475 },
    // S5: long downhill to Pouhon
    { type: "straight", name: "S5",                                   startFrac: 0.475, endFrac: 0.520 },
    // T9-10: Pouhon double-apex — peak at ~54% (3741m)
    { type: "corner",   name: "Pouhon",           direction: "left",  startFrac: 0.520, endFrac: 0.580 },
    // S6: short straight
    { type: "straight", name: "S6",                                   startFrac: 0.580, endFrac: 0.600 },
    // T11-12: Les Fagnes chicane — peaks at ~62-63% (4330-4396m)
    { type: "corner",   name: "Fagnes",           direction: "left",  startFrac: 0.600, endFrac: 0.650 },
    // S7: Campus straight
    { type: "straight", name: "S7",                                   startFrac: 0.650, endFrac: 0.680 },
    // T13-14: Stavelot / Paul Frere — peak at ~70% (4781m)
    { type: "corner",   name: "Stavelot",         direction: "right", startFrac: 0.680, endFrac: 0.755 },
    // S8: straight to Blanchimont
    { type: "straight", name: "S8",                                   startFrac: 0.755, endFrac: 0.785 },
    // T16-17: Blanchimont — fast left
    { type: "corner",   name: "Blanchimont",      direction: "left",  startFrac: 0.785, endFrac: 0.830 },
    // S9: long straight back to Bus Stop
    { type: "straight", name: "S9",                                   startFrac: 0.830, endFrac: 0.915 },
    // T18-19: Bus Stop chicane — peak at ~93.2% (6587m)
    { type: "corner",   name: "Bus Stop",         direction: "right", startFrac: 0.915, endFrac: 1.000 },
  ],

  // Sebring International Raceway — 6.02km full airport circuit
  // Official 17-turn numbering; fractions from generated meta (shared/tracks/meta/sebring.json).
  // Detector over-splits the T15/T16 area into two kinks (0.704–0.754); folded
  // into the S3 straight here so only the 17 official turns remain.
  // Reference: https://en.wikipedia.org/wiki/Sebring_International_Raceway
  "Sebring International Raceway": [
    // Start/finish straight, first half (wraps with the trailing half below)
    { type: "straight", name: "S/F",              startFrac: 0.0000, endFrac: 0.0518, group: "start-finish" },
    { type: "corner",   name: "T1",   direction: "left",  startFrac: 0.0518, endFrac: 0.1354, numbers: [1] },
    { type: "corner",   name: "T2",   direction: "left",  startFrac: 0.1354, endFrac: 0.1702, numbers: [2] },
    { type: "corner",   name: "T3",   direction: "right", startFrac: 0.1702, endFrac: 0.1830, numbers: [3] },
    { type: "corner",   name: "T4",   direction: "left",  startFrac: 0.1830, endFrac: 0.2155, numbers: [4] },
    { type: "straight", name: "S1",   startFrac: 0.2155, endFrac: 0.3134 },
    { type: "corner",   name: "T5",   direction: "right", startFrac: 0.3134, endFrac: 0.3488, numbers: [5] },
    { type: "corner",   name: "T6",   direction: "left",  startFrac: 0.3488, endFrac: 0.3556, numbers: [6] },
    { type: "corner",   name: "T7",   direction: "right", startFrac: 0.3556, endFrac: 0.3722, numbers: [7] },
    { type: "corner",   name: "T8",   direction: "right", startFrac: 0.3722, endFrac: 0.4034, numbers: [8] },
    { type: "corner",   name: "T9",   direction: "left",  startFrac: 0.4034, endFrac: 0.4516, numbers: [9] },
    { type: "corner",   name: "T10",  direction: "right", startFrac: 0.4516, endFrac: 0.4867, numbers: [10] },
    { type: "corner",   name: "T11",  direction: "left",  startFrac: 0.4867, endFrac: 0.5224, numbers: [11] },
    { type: "corner",   name: "T12",  direction: "right", startFrac: 0.5224, endFrac: 0.5478, numbers: [12] },
    { type: "corner",   name: "T13",  direction: "right", startFrac: 0.5478, endFrac: 0.5791, numbers: [13] },
    { type: "straight", name: "S2",   startFrac: 0.5791, endFrac: 0.6064 },
    { type: "corner",   name: "T14",  direction: "left",  startFrac: 0.6064, endFrac: 0.6613, numbers: [14] },
    { type: "corner",   name: "T15",  direction: "right", startFrac: 0.6613, endFrac: 0.7041, numbers: [15] },
    // S3 absorbs the two detector kinks (0.7041–0.7540) between T15 and T16
    { type: "straight", name: "S3",   startFrac: 0.7041, endFrac: 0.8694 },
    { type: "corner",   name: "T16",  direction: "right", startFrac: 0.8694, endFrac: 0.9115, numbers: [16] },
    { type: "corner",   name: "Sunset Bend", direction: "right", startFrac: 0.9115, endFrac: 0.9570, numbers: [17] },
    // Start/finish straight, trailing half
    { type: "straight", name: "S/F",  startFrac: 0.9570, endFrac: 1.0000, group: "start-finish" },
  ],
};
