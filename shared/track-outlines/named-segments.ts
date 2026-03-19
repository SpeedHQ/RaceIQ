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
}

// Keyed by track name (must match tracks.csv name exactly)
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
};
