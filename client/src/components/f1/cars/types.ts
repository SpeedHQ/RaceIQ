export interface F1Driver {
  name: string;
  number: number;
  nationality: string;
}

/** In-game performance ratings (1-100 scale, derived from game data) */
export interface CarStats {
  overallRating: number;
  pace: number;
  straightLineSpeed: number;
  cornerSpeed: number;
  braking: number;
  traction: number;
  aeroEfficiency: number;
  reliability: number;
}

export interface F1Team {
  id: number;
  name: string;
  fullName: string;
  chassis: string;
  powerUnit: string;
  teamPrincipal: string;
  base: string;
  image: string;
  drivers: [F1Driver, F1Driver];
  stats: CarStats;
}

export type ViewMode = "grid" | "table";
