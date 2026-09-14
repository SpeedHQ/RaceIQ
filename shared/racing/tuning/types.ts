export type TuneCategory = 'circuit' | 'wet' | 'low-drag' | 'stable' | 'track-specific';

export interface TuneSettings {
  tires: {
    frontPressure: number;
    rearPressure: number;
    compound?: string;
  };
  gearing: {
    finalDrive: number;
    ratios?: number[];
    topSpeedKph?: number;
    description?: string;
    /** Saved dyno power band (RPM) captured with the tune. */
    powerBandMinRpm?: number;
    powerBandMaxRpm?: number;
  };
  alignment: {
    frontCamber: number;
    rearCamber: number;
    frontToe: number;
    rearToe: number;
    frontCaster?: number;
  };
  antiRollBars: {
    front: number;
    rear: number;
  };
  springs: {
    frontRate: number;
    rearRate: number;
    frontHeight: number;
    rearHeight: number;
    unit?: string;
  };
  damping: {
    frontRebound: number;
    rearRebound: number;
    frontBump: number;
    rearBump: number;
  };
  rollCenterHeight: {
    front: number;
    rear: number;
  };
  antiGeometry: {
    antiDiveFront: number;
    antiSquatRear: number;
  };
  aero: {
    frontDownforce: number;
    rearDownforce: number;
    unit?: string;
  };
  drivetrain?: "rwd" | "fwd" | "awd";
  differential: {
    frontAccel?: number;
    frontDecel?: number;
    rearAccel: number;
    rearDecel: number;
    center?: number;
  };
  brakes: {
    balance: number;
    pressure: number;
  };
}

export interface RaceStrategy {
  condition: "Dry" | "Wet";
  totalLaps: number;
  fuelLoadPercent: number;
  tireCompound: string;
  pitStops: number;
  pitLaps?: number[];
  notes?: string;
}

export interface Tune {
  id: number;
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: RaceStrategy[];
  settings: TuneSettings;
  unitSystem: 'metric' | 'imperial';
  source: 'user' | 'catalog-clone';
  catalogId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TuneAssignment {
  carOrdinal: number;
  trackOrdinal: number;
  tuneId: number;
  tuneName?: string;
}
