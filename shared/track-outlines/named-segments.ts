/**
 * Named corner/straight segments for known tracks.
 * Fractions are relative to the track outline (0 = start/finish, 1 = full lap).
 * These override auto-detected segments for a much better user experience.
 *
 * To calibrate: run the auto-detection, compare distances to real-world references,
 * then define segments here with proper names.
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
  // Outline total ~5747m (bundled TUMFTM data)
  "Circuit de Spa-Francorchamps": [
    { type: "corner",   name: "La Source",        direction: "right", startFrac: 0.000, endFrac: 0.078 },
    { type: "straight", name: "S1",                                   startFrac: 0.078, endFrac: 0.170 },
    { type: "corner",   name: "Eau Rouge",        direction: "left",  startFrac: 0.170, endFrac: 0.210 },
    { type: "straight", name: "Kemmel Straight",                      startFrac: 0.210, endFrac: 0.315 },
    { type: "corner",   name: "Les Combes",       direction: "left",  startFrac: 0.315, endFrac: 0.380 },
    { type: "straight", name: "S3",                                   startFrac: 0.380, endFrac: 0.400 },
    { type: "corner",   name: "Malmedy",          direction: "left",  startFrac: 0.400, endFrac: 0.430 },
    { type: "straight", name: "S4",                                   startFrac: 0.430, endFrac: 0.445 },
    { type: "corner",   name: "Rivage",           direction: "right", startFrac: 0.445, endFrac: 0.475 },
    { type: "straight", name: "S5",                                   startFrac: 0.475, endFrac: 0.525 },
    { type: "corner",   name: "Pouhon",           direction: "left",  startFrac: 0.525, endFrac: 0.580 },
    { type: "straight", name: "S6",                                   startFrac: 0.580, endFrac: 0.620 },
    { type: "corner",   name: "Fagnes",           direction: "left",  startFrac: 0.620, endFrac: 0.660 },
    { type: "straight", name: "S7",                                   startFrac: 0.660, endFrac: 0.690 },
    { type: "corner",   name: "Stavelot",         direction: "right", startFrac: 0.690, endFrac: 0.730 },
    { type: "straight", name: "S8",                                   startFrac: 0.730, endFrac: 0.770 },
    { type: "corner",   name: "Blanchimont",      direction: "left",  startFrac: 0.770, endFrac: 0.830 },
    { type: "straight", name: "S9",                                   startFrac: 0.830, endFrac: 0.950 },
    { type: "corner",   name: "Bus Stop",         direction: "right", startFrac: 0.950, endFrac: 1.000 },
  ],
};
