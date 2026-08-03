import type { SetupSourceMapping } from "./groups";

export const SETUP_FILE_SOURCE_MAPPINGS: Record<
  string,
  SetupSourceMapping
> = {
  "basicSetup.tyres.tyreCompound": {
    semanticId: "setup.tires.compound",
    nativeUnit: "enum",
  },
  "basicSetup.tyres.tyrePressure": {
    semanticId: "setup.tires.starting-pressure",
    nativeUnit: "click",
    kind: "normalized",
    normalization: "kPa = (20.3 + click * 0.1) psi * 6.894757",
  },
  "basicSetup.alignment.camber": {
    semanticId: "setup.alignment.camber",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "basicSetup.alignment.toe": {
    semanticId: "setup.alignment.toe",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "basicSetup.alignment.casterLF": {
    semanticId: "setup.alignment.caster",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve LF click through car-specific setup range",
  },
  "basicSetup.alignment.casterRF": {
    semanticId: "setup.alignment.caster",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve RF click through car-specific setup range",
  },
  "basicSetup.alignment.steerRatio": {
    semanticId: "setup.alignment.steering-ratio",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "basicSetup.electronics.tC1": {
    semanticId: "setup.electronics.traction-control",
    nativeUnit: "level",
  },
  "basicSetup.electronics.tC2": {
    semanticId: "setup.electronics.traction-control-2",
    nativeUnit: "level",
  },
  "basicSetup.electronics.abs": {
    semanticId: "setup.electronics.abs",
    nativeUnit: "level",
  },
  "basicSetup.electronics.eCUMap": {
    semanticId: "setup.electronics.engine-map",
    nativeUnit: "level",
  },
  "basicSetup.electronics.fuelMix": {
    semanticId: "setup.electronics.fuel-mix",
    nativeUnit: "level",
  },
  "basicSetup.electronics.telemetryLaps": {
    semanticId: "setup.electronics.telemetry-laps",
    nativeUnit: "count",
  },
  "basicSetup.strategy.fuel": {
    semanticId: "setup.strategy.fuel-volume",
    nativeUnit: "L",
  },
  "basicSetup.strategy.tyreSet": {
    semanticId: "setup.tires.set",
    nativeUnit: "index",
  },
  "basicSetup.strategy.frontBrakePadCompound": {
    semanticId: "setup.brakes.pad-compound",
    nativeUnit: "enum",
  },
  "basicSetup.strategy.rearBrakePadCompound": {
    semanticId: "setup.brakes.pad-compound",
    nativeUnit: "enum",
  },
  "advancedSetup.mechanicalBalance.aRBFront": {
    semanticId: "setup.suspension.front-anti-roll-bar.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain source anti-roll-bar level",
  },
  "advancedSetup.mechanicalBalance.brakeBias": {
    semanticId: "setup.brakes.bias",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.mechanicalBalance.wheelRate": {
    semanticId: "setup.suspension.spring-rate",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.mechanicalBalance.bumpStopRateUp": {
    semanticId: "setup.suspension.bump-stop-rate",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.mechanicalBalance.bumpStopWindow": {
    semanticId: "setup.suspension.bump-stop-range",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.mechanicalBalance.aRBRear": {
    semanticId: "setup.suspension.rear-anti-roll-bar.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain source anti-roll-bar level",
  },
  "advancedSetup.mechanicalBalance.preloadDifferential": {
    semanticId: "setup.drivetrain.differential-preload",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.dampers.bumpSlow": {
    semanticId: "setup.dampers.slow-compression",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "retain car-specific damper click setting",
  },
  "advancedSetup.dampers.bumpFast": {
    semanticId: "setup.dampers.fast-compression",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "retain car-specific damper click setting",
  },
  "advancedSetup.dampers.reboundSlow": {
    semanticId: "setup.dampers.slow-rebound",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "retain car-specific damper click setting",
  },
  "advancedSetup.dampers.reboundFast": {
    semanticId: "setup.dampers.fast-rebound",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "retain car-specific damper click setting",
  },
  "advancedSetup.aeroBalance.rideHeight": {
    semanticId: "setup.suspension.ride-height",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.aeroBalance.splitter": {
    semanticId: "setup.aero.splitter",
    nativeUnit: "level",
  },
  "advancedSetup.aeroBalance.rearWing": {
    semanticId: "setup.aero.rear-wing.setting",
    nativeUnit: "level",
    kind: "simplified",
    normalization: "retain source discrete rear-wing level",
  },
  "advancedSetup.aeroBalance.brakeDuct": {
    semanticId: "setup.aero.brake-duct",
    nativeUnit: "level",
  },
  "advancedSetup.drivetrain.preload": {
    semanticId: "setup.drivetrain.differential-preload",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.suspension.bumpstops": {
    semanticId: "setup.suspension.bumpstops",
    nativeUnit: "level",
  },
  "advancedSetup.suspension.packers": {
    semanticId: "setup.suspension.packers",
    nativeUnit: "click",
    kind: "simplified",
    normalization: "resolve click through car-specific setup range",
  },
  "advancedSetup.suspension.helperSprings": {
    semanticId: "setup.suspension.helper-springs",
    nativeUnit: "level",
  },
};

