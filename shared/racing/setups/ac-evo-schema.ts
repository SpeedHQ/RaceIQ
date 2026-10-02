import type { SetupConceptId } from "./catalog/concepts";
import type { SetupFileSourceDefinition } from "./catalog/groups";
import type { SectionDef } from "./schema";

/** Flat keys and native values from carSetupToKnobValues, also used by experiment setup IO. */
function knob(path: string, label: string, nativeUnit: string, semanticId: SetupConceptId, step?: number): SetupFileSourceDefinition {
  return { path, label, nativeUnit, semanticId, description: label, cardinality: { kind: "scalar" }, step };
}

export const AC_EVO_SETUP_SCHEMA: readonly SectionDef[] = [
  {
    key: "tyres", label: "Tyres", description: "Decoded starting pressures in psi.", tab: "Tyres", storage: "flat",
    fields: [
      knob("frontLeftTyrePressure", "Front left pressure (psi)", "psi", "setup.tires.starting-pressure", 0.1),
      knob("frontRightTyrePressure", "Front right pressure (psi)", "psi", "setup.tires.starting-pressure", 0.1),
      knob("rearLeftTyrePressure", "Rear left pressure (psi)", "psi", "setup.tires.starting-pressure", 0.1),
      knob("rearRightTyrePressure", "Rear right pressure (psi)", "psi", "setup.tires.starting-pressure", 0.1),
    ],
  },
  {
    key: "alignment", label: "Alignment", description: "Decoded axle alignment and steering ratio.", tab: "Tyres", storage: "flat",
    fields: [
      knob("frontCamber", "Front camber (°)", "deg", "setup.alignment.camber"),
      knob("rearCamber", "Rear camber (°)", "deg", "setup.alignment.camber"),
      knob("frontToe", "Front toe (°)", "deg", "setup.alignment.toe"),
      knob("rearToe", "Rear toe (°)", "deg", "setup.alignment.toe"),
      knob("steerRatio", "Steering ratio", "ratio", "setup.alignment.steering-ratio"),
    ],
  },
  {
    key: "electronics", label: "Electronics", description: "Decoded assistance levels and one-based engine map.", tab: "Electronics", storage: "flat",
    fields: [
      knob("tc", "Traction control", "level", "setup.electronics.traction-control", 1),
      knob("tc2", "Traction control 2", "level", "setup.electronics.traction-control-2", 1),
      knob("abs", "ABS", "level", "setup.electronics.abs", 1),
      knob("engineMap", "Engine map", "level", "setup.electronics.engine-map", 1),
    ],
  },
  {
    key: "strategy", label: "Fuel", description: "Decoded starting fuel volume.", tab: "Fuel & strategy", storage: "flat",
    fields: [knob("fuel", "Fuel (L)", "L", "setup.strategy.fuel-volume")],
  },
  {
    key: "suspension", label: "Suspension", description: "Spring rates use the first decoded corner on each axle; ARBs use verified click values.", tab: "Suspension", storage: "flat",
    fields: [
      knob("frontSpringRate", "Front spring rate (N/m)", "N/m", "setup.suspension.spring-rate"),
      knob("rearSpringRate", "Rear spring rate (N/m)", "N/m", "setup.suspension.spring-rate"),
      knob("frontARB", "Front anti-roll bar (clicks)", "click", "setup.suspension.front-anti-roll-bar.setting", 1),
      knob("rearARB", "Rear anti-roll bar (clicks)", "click", "setup.suspension.rear-anti-roll-bar.setting", 1),
    ],
  },
  {
    key: "brakes", label: "Brakes", description: "Decoded front brake bias in percent.", tab: "Suspension", storage: "flat",
    fields: [knob("brakeBias", "Brake bias (%)", "%", "setup.brakes.bias")],
  },
  {
    key: "drivetrain", label: "Differential", description: "Decoded power/coast fractions and differential preload.", tab: "Suspension", storage: "flat",
    fields: [
      knob("diffPower", "Differential power (fraction)", "ratio", "setup.drivetrain.on-throttle-lock"),
      knob("diffCoast", "Differential coast (fraction)", "ratio", "setup.drivetrain.off-throttle-lock"),
      knob("diffPreload", "Differential preload (Nm)", "Nm", "setup.drivetrain.differential-preload"),
    ],
  },
  {
    key: "dampers", label: "Dampers", description: "Bump and rebound use the first decoded corner on each axle.", tab: "Dampers", storage: "flat",
    fields: [
      knob("frontBump", "Front bump", "level", "setup.dampers.compression"),
      knob("rearBump", "Rear bump", "level", "setup.dampers.compression"),
      knob("frontRebound", "Front rebound", "level", "setup.dampers.rebound"),
      knob("rearRebound", "Rear rebound", "level", "setup.dampers.rebound"),
    ],
  },
  {
    key: "aero", label: "Aero", description: "Decoded wing levels and ride heights in mm.", tab: "Aero", storage: "flat",
    fields: [
      knob("frontRideHeight", "Front ride height (mm)", "mm", "setup.suspension.ride-height"),
      knob("rearRideHeight", "Rear ride height (mm)", "mm", "setup.suspension.ride-height"),
      knob("frontWing", "Front wing", "level", "setup.aero.front-wing"),
      knob("rearWing", "Rear wing", "level", "setup.aero.rear-wing.setting"),
    ],
  },
];
