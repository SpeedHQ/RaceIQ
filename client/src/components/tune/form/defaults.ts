// Tune form defaults.
import type { TuneSettings } from "@/data/tune-catalog";

export function defaultTuneSettings(): TuneSettings {
  return {
    tires: { frontPressure: 1.7, rearPressure: 1.7 },
    gearing: {
      finalDrive: 3.5,
      ratios: [3.5, 2.5, 1.9, 1.5, 1.2, 1.0],
      topSpeedKph: 250,
    },
    alignment: {
      frontCamber: -1.0,
      rearCamber: -0.5,
      frontToe: 0.0,
      rearToe: 0.0,
    },
    antiRollBars: { front: 20, rear: 20 },
    springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
    damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
    rollCenterHeight: { front: 0, rear: 0 },
    antiGeometry: { antiDiveFront: 0, antiSquatRear: 0 },
    aero: { frontDownforce: 100, rearDownforce: 100 },
    differential: { rearAccel: 60, rearDecel: 30 },
    brakes: { balance: 50, pressure: 100 },
  };
}
export function withDefaults(s?: TuneSettings): TuneSettings {
  if (!s) return defaultTuneSettings();
  return {
    ...s,
    rollCenterHeight: s.rollCenterHeight ?? { front: 0, rear: 0 },
    antiGeometry: s.antiGeometry ?? { antiDiveFront: 0, antiSquatRear: 0 },
  };
}
