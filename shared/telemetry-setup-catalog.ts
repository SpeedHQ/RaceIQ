export type SetupCatalogShape =
  | "scalar"
  | "per-wheel"
  | "vector"
  | "array"
  | "structured";

export interface SetupGroupDefinition {
  id: string;
  label: string;
  description: string;
  parentId: string;
}

export interface SetupConceptDefinition {
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  shape: SetupCatalogShape;
}

export interface SetupSourceMapping {
  semanticId: string;
  nativeUnit: string;
  kind?: "direct" | "normalized" | "derived" | "simplified";
  normalization?: string;
}

export const SETUP_GROUP_DEFINITIONS: readonly SetupGroupDefinition[] = [
  {
    id: "setup.metadata",
    label: "Setup metadata",
    description: "Setup identity, revision, and unmatched source-specific data.",
    parentId: "setup",
  },
  {
    id: "setup.tires",
    label: "Tires",
    description: "Configured tire compound, pressures, and setup-screen tire state.",
    parentId: "setup",
  },
  {
    id: "setup.alignment",
    label: "Alignment and steering",
    description: "Camber, caster, toe, and steering-ratio settings.",
    parentId: "setup",
  },
  {
    id: "setup.suspension",
    label: "Suspension",
    description: "Ride height, springs, bump stops, and anti-roll-bar settings.",
    parentId: "setup",
  },
  {
    id: "setup.suspension.front-anti-roll-bar",
    label: "Front anti-roll bar",
    description: "Front anti-roll-bar setting and detailed construction values.",
    parentId: "setup.suspension",
  },
  {
    id: "setup.suspension.rear-anti-roll-bar",
    label: "Rear anti-roll bar",
    description: "Rear anti-roll-bar setting and detailed construction values.",
    parentId: "setup.suspension",
  },
  {
    id: "setup.dampers",
    label: "Dampers",
    description: "Compression and rebound damper settings.",
    parentId: "setup",
  },
  {
    id: "setup.aero",
    label: "Aerodynamics",
    description: "Wing, splitter, brake-duct, and at-speed aero settings.",
    parentId: "setup",
  },
  {
    id: "setup.aero.rear-wing",
    label: "Rear wing",
    description: "Rear-wing setting and physical angle values.",
    parentId: "setup.aero",
  },
  {
    id: "setup.brakes",
    label: "Brakes",
    description: "Brake pressure, bias, pad, and master-cylinder settings.",
    parentId: "setup",
  },
  {
    id: "setup.electronics",
    label: "Electronics",
    description: "ABS, traction control, engine map, and other in-car settings.",
    parentId: "setup",
  },
  {
    id: "setup.drivetrain",
    label: "Drivetrain",
    description: "Differential, engine-braking, and transmission settings.",
    parentId: "setup",
  },
  {
    id: "setup.strategy",
    label: "Strategy",
    description: "Fuel, tire-set, and stint configuration.",
    parentId: "setup",
  },
  {
    id: "setup.weight",
    label: "Weight distribution",
    description: "Corner weights and cross-weight settings.",
    parentId: "setup",
  },
];

export const SETUP_CONCEPT_DEFINITIONS: Record<
  string,
  SetupConceptDefinition
> = {
  "setup.metadata.update-count": {
    label: "Setup update count",
    description: "Source revision counter incremented when active setup changes.",
    parentId: "setup.metadata",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "setup.metadata.name": {
    label: "Setup name",
    description: "Display name of active setup.",
    parentId: "setup.metadata",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "setup.metadata.modified": {
    label: "Setup modified",
    description: "Whether active setup differs from loaded setup file.",
    parentId: "setup.metadata",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "setup.metadata.load-type": {
    label: "Setup load type",
    description: "How active setup was loaded or selected.",
    parentId: "setup.metadata",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "setup.metadata.passed-tech": {
    label: "Setup passed tech",
    description: "Whether active setup passed simulator technical inspection.",
    parentId: "setup.metadata",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "setup.metadata.fixed": {
    label: "Fixed setup session",
    description: "Whether session enforces fixed vehicle setup.",
    parentId: "setup.metadata",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "setup.metadata.unmapped-source-values": {
    label: "Unmapped source-specific setup values",
    description:
      "Car- or build-specific setup leaves not yet assigned to a stable shared concept.",
    parentId: "setup.metadata",
    canonicalUnit: "structured",
    shape: "structured",
  },
  "setup.tires.compound": {
    label: "Configured tire compound",
    description: "Tire compound selected by setup or strategy.",
    parentId: "setup.tires",
    canonicalUnit: "enum",
    shape: "scalar",
  },
  "setup.tires.starting-pressure": {
    label: "Starting tire pressure",
    description: "Cold or starting pressure configured for each tire.",
    parentId: "setup.tires",
    canonicalUnit: "kPa",
    shape: "per-wheel",
  },
  "setup.tires.last-hot-pressure": {
    label: "Last hot tire pressure",
    description: "Most recent hot pressure shown with active setup for each tire.",
    parentId: "setup.tires",
    canonicalUnit: "kPa",
    shape: "per-wheel",
  },
  "setup.tires.last-temperature-bands": {
    label: "Last tire temperature bands",
    description:
      "Most recent outside/middle/inside or inside/middle/outside tire temperatures stored with setup.",
    parentId: "setup.tires",
    canonicalUnit: "°C",
    shape: "structured",
  },
  "setup.tires.tread-remaining": {
    label: "Tread remaining bands",
    description: "Remaining tread percentage bands stored with active setup.",
    parentId: "setup.tires",
    canonicalUnit: "%",
    shape: "structured",
  },
  "setup.tires.set": {
    label: "Tire set",
    description: "Selected tire-set identifier.",
    parentId: "setup.tires",
    canonicalUnit: "index",
    shape: "scalar",
  },
  "setup.alignment.camber": {
    label: "Camber",
    description:
      "Static wheel camber. Axle-only sources apply one value to both wheels on that axle.",
    parentId: "setup.alignment",
    canonicalUnit: "°",
    shape: "per-wheel",
  },
  "setup.alignment.caster": {
    label: "Caster",
    description: "Static steering-axis caster for supported front wheels.",
    parentId: "setup.alignment",
    canonicalUnit: "°",
    shape: "per-wheel",
  },
  "setup.alignment.toe": {
    label: "Toe",
    description:
      "Static wheel toe. Axle-only sources apply one value to both wheels on that axle.",
    parentId: "setup.alignment",
    canonicalUnit: "°",
    shape: "per-wheel",
  },
  "setup.alignment.steering-ratio": {
    label: "Steering ratio",
    description: "Steering-wheel rotation to road-wheel steering ratio.",
    parentId: "setup.alignment",
    canonicalUnit: "ratio",
    shape: "scalar",
  },
  "setup.suspension.ride-height": {
    label: "Configured ride height",
    description:
      "Static ride-height setting. Axle-only sources apply one value across axle.",
    parentId: "setup.suspension",
    canonicalUnit: "mm",
    shape: "per-wheel",
  },
  "setup.suspension.shock-deflection": {
    label: "Static shock deflection",
    description: "Shock deflection shown in setup screen for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "mm",
    shape: "per-wheel",
  },
  "setup.suspension.spring-perch-offset": {
    label: "Spring perch offset",
    description: "Spring perch or platform offset for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "mm",
    shape: "per-wheel",
  },
  "setup.suspension.spring-rate": {
    label: "Spring or wheel rate",
    description:
      "Spring stiffness or closest simulator-specific wheel-rate setting for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "N/mm",
    shape: "per-wheel",
  },
  "setup.suspension.spring-selection": {
    label: "Spring selection",
    description: "Discrete spring choice for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "index",
    shape: "per-wheel",
  },
  "setup.suspension.front-anti-roll-bar.setting": {
    label: "Front anti-roll-bar setting",
    description: "Primary front anti-roll-bar stiffness or adjustment setting.",
    parentId: "setup.suspension.front-anti-roll-bar",
    canonicalUnit: "configuration",
    shape: "scalar",
  },
  "setup.suspension.rear-anti-roll-bar.setting": {
    label: "Rear anti-roll-bar setting",
    description: "Primary rear anti-roll-bar stiffness or adjustment setting.",
    parentId: "setup.suspension.rear-anti-roll-bar",
    canonicalUnit: "configuration",
    shape: "scalar",
  },
  "setup.suspension.front-anti-roll-bar.arms": {
    label: "Front anti-roll-bar arms",
    description: "Front anti-roll-bar arm count or position.",
    parentId: "setup.suspension.front-anti-roll-bar",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "setup.suspension.rear-anti-roll-bar.arms": {
    label: "Rear anti-roll-bar arms",
    description: "Rear anti-roll-bar arm count or position.",
    parentId: "setup.suspension.rear-anti-roll-bar",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "setup.suspension.front-anti-roll-bar.blades": {
    label: "Front anti-roll-bar blades",
    description: "Front anti-roll-bar blade setting.",
    parentId: "setup.suspension.front-anti-roll-bar",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.suspension.rear-anti-roll-bar.blades": {
    label: "Rear anti-roll-bar blades",
    description: "Rear anti-roll-bar blade setting.",
    parentId: "setup.suspension.rear-anti-roll-bar",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.suspension.front-anti-roll-bar.diameter": {
    label: "Front anti-roll-bar diameter",
    description: "Front anti-roll-bar diameter.",
    parentId: "setup.suspension.front-anti-roll-bar",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.suspension.rear-anti-roll-bar.diameter": {
    label: "Rear anti-roll-bar diameter",
    description: "Rear anti-roll-bar diameter.",
    parentId: "setup.suspension.rear-anti-roll-bar",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.suspension.front-anti-roll-bar.outer-diameter": {
    label: "Front anti-roll-bar outer diameter",
    description: "Front anti-roll-bar outer diameter.",
    parentId: "setup.suspension.front-anti-roll-bar",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.suspension.rear-anti-roll-bar.outer-diameter": {
    label: "Rear anti-roll-bar outer diameter",
    description: "Rear anti-roll-bar outer diameter.",
    parentId: "setup.suspension.rear-anti-roll-bar",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.suspension.bump-stop-rate": {
    label: "Bump-stop rate",
    description: "Bump-stop stiffness for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "N/mm",
    shape: "per-wheel",
  },
  "setup.suspension.bump-stop-range": {
    label: "Bump-stop range",
    description: "Bump-stop working range or window for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "mm",
    shape: "per-wheel",
  },
  "setup.suspension.bumpstops": {
    label: "Bump-stop selection",
    description: "Discrete bump-stop selection for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.suspension.packers": {
    label: "Packers",
    description: "Suspension packer setting for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "mm",
    shape: "per-wheel",
  },
  "setup.suspension.helper-springs": {
    label: "Helper springs",
    description: "Helper-spring selection for each wheel.",
    parentId: "setup.suspension",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.compression": {
    label: "Compression damping",
    description: "Single-rate compression or bump damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.rebound": {
    label: "Rebound damping",
    description: "Single-rate rebound damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.slow-compression": {
    label: "Slow compression damping",
    description: "Low-speed compression damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.fast-compression": {
    label: "Fast compression damping",
    description: "High-speed compression damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.slow-rebound": {
    label: "Slow rebound damping",
    description: "Low-speed rebound damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.dampers.fast-rebound": {
    label: "Fast rebound damping",
    description: "High-speed rebound damping for each wheel.",
    parentId: "setup.dampers",
    canonicalUnit: "level",
    shape: "per-wheel",
  },
  "setup.aero.front-wing": {
    label: "Front wing",
    description: "Front wing or front aerodynamic adjustment.",
    parentId: "setup.aero",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.aero.rear-wing.setting": {
    label: "Rear wing setting",
    description: "Rear wing discrete level or configuration setting.",
    parentId: "setup.aero.rear-wing",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.aero.rear-wing.angle": {
    label: "Rear wing angle",
    description: "Physical rear wing angle.",
    parentId: "setup.aero.rear-wing",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "setup.aero.front-downforce": {
    label: "Calculated front downforce",
    description: "Setup-screen calculated front downforce or aero balance.",
    parentId: "setup.aero",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.aero.front-ride-height-at-speed": {
    label: "Calculated front ride height at speed",
    description: "Setup-screen predicted front ride height at reference speed.",
    parentId: "setup.aero",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.aero.rear-ride-height-at-speed": {
    label: "Calculated rear ride height at speed",
    description: "Setup-screen predicted rear ride height at reference speed.",
    parentId: "setup.aero",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.aero.splitter": {
    label: "Splitter",
    description: "Front splitter setting.",
    parentId: "setup.aero",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.aero.brake-duct": {
    label: "Brake ducts",
    description: "Front and rear brake-duct opening settings.",
    parentId: "setup.aero",
    canonicalUnit: "level",
    shape: "structured",
  },
  "setup.brakes.bias": {
    label: "Configured front brake bias",
    description: "Front-axle brake-pressure bias stored in setup.",
    parentId: "setup.brakes",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.brakes.pressure": {
    label: "Configured brake pressure",
    description: "Maximum brake pressure setting.",
    parentId: "setup.brakes",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.brakes.pad-compound": {
    label: "Brake pad compound",
    description: "Front and rear brake-pad compound selections.",
    parentId: "setup.brakes",
    canonicalUnit: "enum",
    shape: "structured",
  },
  "setup.brakes.front-master-cylinder": {
    label: "Front master cylinder",
    description: "Front brake master-cylinder diameter or selection.",
    parentId: "setup.brakes",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.brakes.rear-master-cylinder": {
    label: "Rear master cylinder",
    description: "Rear brake master-cylinder diameter or selection.",
    parentId: "setup.brakes",
    canonicalUnit: "mm",
    shape: "scalar",
  },
  "setup.electronics.traction-control": {
    label: "Configured traction control",
    description: "Primary traction-control setting.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.traction-control-2": {
    label: "Configured traction control 2",
    description: "Secondary traction-control setting.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.abs": {
    label: "Configured ABS",
    description: "Anti-lock braking setting stored in setup.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.engine-map": {
    label: "Configured engine map",
    description: "Engine or ECU map stored in setup.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.fuel-mix": {
    label: "Configured fuel mix",
    description: "Fuel-mixture setting stored in setup.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.throttle-shape": {
    label: "Throttle shape",
    description: "Throttle-response curve setting.",
    parentId: "setup.electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "setup.electronics.display-page": {
    label: "Display page",
    description: "Configured in-car display page.",
    parentId: "setup.electronics",
    canonicalUnit: "index",
    shape: "scalar",
  },
  "setup.electronics.telemetry-laps": {
    label: "Telemetry laps",
    description: "Number of telemetry-recording laps configured in setup.",
    parentId: "setup.electronics",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "setup.drivetrain.differential-preload": {
    label: "Differential preload",
    description: "Mechanical differential preload.",
    parentId: "setup.drivetrain",
    canonicalUnit: "Nm",
    shape: "scalar",
  },
  "setup.drivetrain.differential-clutch-plates": {
    label: "Differential clutch plates",
    description: "Number of friction faces or clutch plates in differential.",
    parentId: "setup.drivetrain",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "setup.drivetrain.differential-drive-ramp": {
    label: "Differential drive ramp",
    description: "Power-side differential ramp angle.",
    parentId: "setup.drivetrain",
    canonicalUnit: "°",
    shape: "scalar",
  },
  "setup.drivetrain.differential-coast-ramp": {
    label: "Differential coast ramp",
    description: "Coast-side differential ramp angle.",
    parentId: "setup.drivetrain",
    canonicalUnit: "°",
    shape: "scalar",
  },
  "setup.drivetrain.on-throttle-lock": {
    label: "On-throttle differential",
    description: "Power-side differential locking setting.",
    parentId: "setup.drivetrain",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.drivetrain.off-throttle-lock": {
    label: "Off-throttle differential",
    description: "Coast-side differential locking setting.",
    parentId: "setup.drivetrain",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.drivetrain.engine-braking": {
    label: "Engine braking",
    description: "Configured engine-braking strength.",
    parentId: "setup.drivetrain",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "setup.drivetrain.final-drive": {
    label: "Final drive",
    description: "Transmission final-drive ratio or selection.",
    parentId: "setup.drivetrain",
    canonicalUnit: "ratio",
    shape: "scalar",
  },
  "setup.drivetrain.gear-ratios": {
    label: "Gear ratios",
    description: "Individual forward-gear ratios or selections.",
    parentId: "setup.drivetrain",
    canonicalUnit: "ratio",
    shape: "array",
  },
  "setup.strategy.fuel-volume": {
    label: "Configured fuel volume",
    description: "Starting fuel specified by volume.",
    parentId: "setup.strategy",
    canonicalUnit: "L",
    shape: "scalar",
  },
  "setup.strategy.fuel-mass": {
    label: "Configured fuel mass",
    description: "Starting fuel specified by mass.",
    parentId: "setup.strategy",
    canonicalUnit: "kg",
    shape: "scalar",
  },
  "setup.weight.corner-weight": {
    label: "Corner weight",
    description: "Static weight supported at each wheel.",
    parentId: "setup.weight",
    canonicalUnit: "N",
    shape: "per-wheel",
  },
  "setup.weight.cross-weight": {
    label: "Cross weight",
    description: "Diagonal cross-weight percentage.",
    parentId: "setup.weight",
    canonicalUnit: "%",
    shape: "scalar",
  },
};

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
