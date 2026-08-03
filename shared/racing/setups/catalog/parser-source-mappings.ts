import type { SetupSourceMapping } from "./groups";

export const SETUP_PARSER_SOURCE_MAPPINGS: Record<
  string,
  SetupSourceMapping
> = {
  "f1.setup.frontWing": {
    semanticId: "setup.aero.front-wing",
    nativeUnit: "level",
  },
  "f1.setup.rearWing": {
    semanticId: "setup.aero.rear-wing.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain F1 discrete rear-wing level",
  },
  "f1.setup.onThrottle": {
    semanticId: "setup.drivetrain.on-throttle-lock",
    nativeUnit: "%",
  },
  "f1.setup.offThrottle": {
    semanticId: "setup.drivetrain.off-throttle-lock",
    nativeUnit: "%",
  },
  "f1.setup.frontCamber": {
    semanticId: "setup.alignment.camber",
    nativeUnit: "°",
    kind: "simplified",
    normalization: "apply front-axle value to FL and FR",
  },
  "f1.setup.rearCamber": {
    semanticId: "setup.alignment.camber",
    nativeUnit: "°",
    kind: "simplified",
    normalization: "apply rear-axle value to RL and RR",
  },
  "f1.setup.frontToe": {
    semanticId: "setup.alignment.toe",
    nativeUnit: "°",
    kind: "simplified",
    normalization: "apply front-axle value to FL and FR",
  },
  "f1.setup.rearToe": {
    semanticId: "setup.alignment.toe",
    nativeUnit: "°",
    kind: "simplified",
    normalization: "apply rear-axle value to RL and RR",
  },
  "f1.setup.frontSuspension": {
    semanticId: "setup.suspension.spring-rate",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain front-axle 1-11 stiffness level",
  },
  "f1.setup.rearSuspension": {
    semanticId: "setup.suspension.spring-rate",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain rear-axle 1-11 stiffness level",
  },
  "f1.setup.frontAntiRollBar": {
    semanticId: "setup.suspension.front-anti-roll-bar.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain F1 front anti-roll-bar level",
  },
  "f1.setup.rearAntiRollBar": {
    semanticId: "setup.suspension.rear-anti-roll-bar.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain F1 rear anti-roll-bar level",
  },
  "f1.setup.frontRideHeight": {
    semanticId: "setup.suspension.ride-height",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain front-axle 1-50 ride-height level",
  },
  "f1.setup.rearRideHeight": {
    semanticId: "setup.suspension.ride-height",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain rear-axle 1-50 ride-height level",
  },
  "f1.setup.brakePressure": {
    semanticId: "setup.brakes.pressure",
    nativeUnit: "%",
  },
  "f1.setup.brakeBias": {
    semanticId: "setup.brakes.bias",
    nativeUnit: "%",
  },
  "f1.setup.engineBraking": {
    semanticId: "setup.drivetrain.engine-braking",
    nativeUnit: "%",
  },
  "f1.setup.frontLeftTyrePressure": {
    semanticId: "setup.tires.starting-pressure",
    nativeUnit: "psi",
    kind: "normalized",
    normalization: "psi * 6.894757",
  },
  "f1.setup.frontRightTyrePressure": {
    semanticId: "setup.tires.starting-pressure",
    nativeUnit: "psi",
    kind: "normalized",
    normalization: "psi * 6.894757",
  },
  "f1.setup.rearLeftTyrePressure": {
    semanticId: "setup.tires.starting-pressure",
    nativeUnit: "psi",
    kind: "normalized",
    normalization: "psi * 6.894757",
  },
  "f1.setup.rearRightTyrePressure": {
    semanticId: "setup.tires.starting-pressure",
    nativeUnit: "psi",
    kind: "normalized",
    normalization: "psi * 6.894757",
  },
  "f1.setup.fuelLoad": {
    semanticId: "setup.strategy.fuel-mass",
    nativeUnit: "kg",
  },
};

