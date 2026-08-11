import type {
  SetupFieldCardinality,
  SetupFileSectionDefinition,
  SetupFileSectionMetadata,
  SetupFileSourceDefinition,
  SetupFileSourceMetadata,
  SetupFileSourceTree,
  SetupFormTab,
} from "./groups";
import type { SetupConceptId } from "./concepts";

const KUNOS_SETUP_GAMES = ["acc", "ac-evo"] as const;
const AC_EVO_SETUP_GAMES = ["ac-evo"] as const;

export const SETUP_CORNER_ORDER = ["FL", "FR", "RL", "RR"] as const;
export const SETUP_AXLE_ORDER = ["Front", "Rear"] as const;

export const SETUP_FORM_TAB_ORDER = [
  "Tyres",
  "Electronics",
  "Fuel & strategy",
  "Suspension",
  "Dampers",
  "Aero",
] as const satisfies readonly SetupFormTab[];

export const SETUP_FIELD_CARDINALITIES = {
  scalar: { kind: "scalar" },
  corners: {
    kind: "fixed",
    count: 4,
    ordering: SETUP_CORNER_ORDER,
  },
  axles: {
    kind: "fixed",
    count: 2,
    ordering: SETUP_AXLE_ORDER,
  },
} as const satisfies Record<string, SetupFieldCardinality>;

type CataloguedSetupFileSourceMetadata = Omit<
  SetupFileSourceMetadata,
  "semanticId"
> & {
  semanticId: SetupConceptId;
};

type CataloguedSetupFileSourceTree = Record<
  string,
  Record<
    string,
    SetupFileSectionMetadata & {
      fields: Record<string, CataloguedSetupFileSourceMetadata>;
    }
  >
>;

export const SETUP_FILE_SOURCE_TREE = {
  basicSetup: {
    tyres: {
      label: "Tyres",
      description: "Tyre compound and starting pressure controls.",
      tab: "Tyres",
      games: KUNOS_SETUP_GAMES,
      fields: {
        tyreCompound: {
          label: "Compound",
          description: "Dry or wet tyre compound stored by the setup file.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          hint: "0 = dry, 1 = wet",
          semanticId: "setup.tires.compound",
          nativeUnit: "enum",
        },
        tyrePressure: {
          label: "Pressure (clicks)",
          description: "Starting tyre pressure clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          hint: "20.3 psi + n × 0.1",
          semanticId: "setup.tires.starting-pressure",
          nativeUnit: "click",
          kind: "normalized",
          normalization: "kPa = (20.3 + click * 0.1) psi * 6.894757",
        },
      },
    },
    alignment: {
      label: "Alignment",
      description: "Camber, toe, caster, and steering-ratio controls.",
      tab: "Tyres",
      games: KUNOS_SETUP_GAMES,
      fields: {
        camber: {
          label: "Camber (clicks)",
          description: "Camber clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.alignment.camber",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        toe: {
          label: "Toe (clicks)",
          description: "Toe clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.alignment.toe",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        casterLF: {
          label: "Caster LF",
          description: "Left-front caster click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.alignment.caster",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve LF click through car-specific setup range",
        },
        casterRF: {
          label: "Caster RF",
          description: "Right-front caster click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.alignment.caster",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve RF click through car-specific setup range",
        },
        steerRatio: {
          label: "Steer Ratio",
          description: "Steering-ratio click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.alignment.steering-ratio",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
      },
    },
    electronics: {
      label: "Electronics",
      description: "Driver aids, engine maps, fuel mix, and telemetry controls.",
      tab: "Electronics",
      games: KUNOS_SETUP_GAMES,
      fields: {
        tC1: {
          label: "TC1",
          description: "Primary traction-control level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.traction-control",
          nativeUnit: "level",
        },
        tC2: {
          label: "TC2",
          description: "Secondary traction-control level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.traction-control-2",
          nativeUnit: "level",
        },
        abs: {
          label: "ABS",
          description: "Anti-lock braking level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.abs",
          nativeUnit: "level",
        },
        eCUMap: {
          label: "ECU Map",
          description: "Engine-control-unit map level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.engine-map",
          nativeUnit: "level",
        },
        fuelMix: {
          label: "Fuel Mix",
          description: "Fuel-mixture level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.fuel-mix",
          nativeUnit: "level",
        },
        telemetryLaps: {
          label: "Telemetry Laps",
          description: "Number of laps retained by in-game telemetry logging.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.electronics.telemetry-laps",
          nativeUnit: "count",
        },
      },
    },
    strategy: {
      label: "Strategy",
      description: "Fuel, tyre-set, and brake-pad strategy controls.",
      tab: "Fuel & strategy",
      games: KUNOS_SETUP_GAMES,
      fields: {
        fuel: {
          label: "Fuel (L)",
          description: "Starting fuel volume.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.strategy.fuel-volume",
          nativeUnit: "L",
        },
        tyreSet: {
          label: "Tyre Set",
          description: "Selected tyre-set index.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.tires.set",
          nativeUnit: "index",
        },
        frontBrakePadCompound: {
          label: "Front Brake Pads",
          description: "Front brake-pad compound.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.brakes.pad-compound",
          nativeUnit: "enum",
        },
        rearBrakePadCompound: {
          label: "Rear Brake Pads",
          description: "Rear brake-pad compound.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.brakes.pad-compound",
          nativeUnit: "enum",
        },
      },
    },
  },
  advancedSetup: {
    mechanicalBalance: {
      label: "Suspension",
      description: "Mechanical balance, springs, bumpstops, brakes, and anti-roll bars.",
      tab: "Suspension",
      games: KUNOS_SETUP_GAMES,
      fields: {
        aRBFront: {
          label: "Front Anti Roll Bar",
          description: "Front anti-roll-bar level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.suspension.front-anti-roll-bar.setting",
          nativeUnit: "level",
          kind: "simplified",
          normalization: "retain source anti-roll-bar level",
        },
        aRBRear: {
          label: "Rear Anti Roll Bar",
          description: "Rear anti-roll-bar level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.suspension.rear-anti-roll-bar.setting",
          nativeUnit: "level",
          kind: "simplified",
          normalization: "retain source anti-roll-bar level",
        },
        brakeBias: {
          label: "Brake Bias (clicks)",
          description: "Brake-bias click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.brakes.bias",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        wheelRate: {
          label: "Wheel Rate",
          description: "Wheel-rate clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.spring-rate",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        bumpStopRateUp: {
          label: "Bumpstop Rate",
          description: "Bumpstop-rate clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.bump-stop-rate",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        bumpStopWindow: {
          label: "Bumpstop Range",
          description: "Bumpstop-range clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.bump-stop-range",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        preloadDifferential: {
          label: "Differential Preload",
          description: "Differential-preload click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.drivetrain.differential-preload",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
      },
    },
    dampers: {
      label: "Dampers",
      description: "Slow and fast compression and rebound controls.",
      tab: "Dampers",
      games: KUNOS_SETUP_GAMES,
      fields: {
        bumpSlow: {
          label: "Bump Slow",
          description: "Low-speed compression clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.dampers.slow-compression",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "retain car-specific damper click setting",
        },
        bumpFast: {
          label: "Bump Fast",
          description: "High-speed compression clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.dampers.fast-compression",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "retain car-specific damper click setting",
        },
        reboundSlow: {
          label: "Rebound Slow",
          description: "Low-speed rebound clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.dampers.slow-rebound",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "retain car-specific damper click setting",
        },
        reboundFast: {
          label: "Rebound Fast",
          description: "High-speed rebound clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.dampers.fast-rebound",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "retain car-specific damper click setting",
        },
      },
    },
    aeroBalance: {
      label: "Aero & Ride",
      description: "Ride height, splitter, rear wing, and brake-duct controls.",
      tab: "Aero",
      games: KUNOS_SETUP_GAMES,
      fields: {
        rideHeight: {
          label: "Ride Height",
          description: "Ride-height clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.ride-height",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        splitter: {
          label: "Splitter",
          description: "Front splitter level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.aero.splitter",
          nativeUnit: "level",
        },
        rearWing: {
          label: "Rear Wing",
          description: "Rear-wing level.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.aero.rear-wing.setting",
          nativeUnit: "level",
          kind: "simplified",
          normalization: "retain source discrete rear-wing level",
        },
        brakeDuct: {
          label: "Brake Duct",
          description: "Front and rear brake-duct levels.",
          cardinality: SETUP_FIELD_CARDINALITIES.axles,
          semanticId: "setup.aero.brake-duct",
          nativeUnit: "level",
        },
      },
    },
    drivetrain: {
      label: "Drivetrain",
      description: "Differential and drivetrain controls.",
      tab: "Suspension",
      games: KUNOS_SETUP_GAMES,
      fields: {
        preload: {
          label: "Diff Preload",
          description: "Differential-preload click.",
          cardinality: SETUP_FIELD_CARDINALITIES.scalar,
          semanticId: "setup.drivetrain.differential-preload",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
      },
    },
    suspension: {
      label: "Suspension Presets",
      description: "Assetto Corsa Evo bumpstop, packer, and helper-spring controls.",
      tab: "Suspension",
      games: AC_EVO_SETUP_GAMES,
      fields: {
        bumpstops: {
          label: "Bumpstops",
          description: "Bumpstop levels in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.bumpstops",
          nativeUnit: "level",
        },
        packers: {
          label: "Packers",
          description: "Packer clicks in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.packers",
          nativeUnit: "click",
          kind: "simplified",
          normalization: "resolve click through car-specific setup range",
        },
        helperSprings: {
          label: "Helper Springs",
          description: "Helper-spring levels in FL, FR, RL, RR order.",
          cardinality: SETUP_FIELD_CARDINALITIES.corners,
          semanticId: "setup.suspension.helper-springs",
          nativeUnit: "level",
        },
      },
    },
  },
} as const satisfies CataloguedSetupFileSourceTree;

type StringKey<Value> = Extract<keyof Value, string>;

type SourceFromSection<
  Section,
  Prefix extends string,
> = Section extends { fields: infer Fields extends Record<string, SetupFileSourceMetadata> }
  ? {
      [Field in StringKey<Fields>]: Fields[Field] &
        SetupFileSourceMetadata & {
          readonly path: `${Prefix}.${Field}`;
        };
    }[StringKey<Fields>]
  : never;

type SourceFromTree<Tree extends SetupFileSourceTree> = {
  [Root in StringKey<Tree>]: {
    [Section in StringKey<Tree[Root]>]: SourceFromSection<
      Tree[Root][Section],
      `${Root}.${Section}`
    >;
  }[StringKey<Tree[Root]>];
}[StringKey<Tree>];

type SectionFromTree<Tree extends SetupFileSourceTree> = {
  [Root in StringKey<Tree>]: {
    [Section in StringKey<Tree[Root]>]: Omit<
      Tree[Root][Section],
      "fields"
    > &
      SetupFileSectionMetadata & {
        readonly id: `${Root}.${Section}`;
      };
  }[StringKey<Tree[Root]>];
}[StringKey<Tree>];

function compileSourceDefinitions<const Tree extends SetupFileSourceTree>(
  tree: Tree,
): readonly SourceFromTree<Tree>[] {
  const definitions: SetupFileSourceDefinition[] = [];
  for (const [root, sections] of Object.entries(tree)) {
    for (const [section, definition] of Object.entries(sections)) {
      for (const [field, metadata] of Object.entries(definition.fields)) {
        definitions.push({
          ...metadata,
          path: `${root}.${section}.${field}`,
        });
      }
    }
  }
  return definitions as unknown as readonly SourceFromTree<Tree>[];
}

function compileSectionDefinitions<const Tree extends SetupFileSourceTree>(
  tree: Tree,
): readonly SectionFromTree<Tree>[] {
  const definitions: SetupFileSectionDefinition[] = [];
  for (const [root, sections] of Object.entries(tree)) {
    for (const [section, { fields: _fields, ...metadata }] of Object.entries(
      sections,
    )) {
      definitions.push({
        ...metadata,
        id: `${root}.${section}`,
      });
    }
  }
  return definitions as unknown as readonly SectionFromTree<Tree>[];
}

export const SETUP_FILE_SOURCE_DEFINITIONS =
  compileSourceDefinitions(SETUP_FILE_SOURCE_TREE);

export const SETUP_FILE_SECTION_DEFINITIONS =
  compileSectionDefinitions(SETUP_FILE_SOURCE_TREE);

export type SetupFileSource =
  (typeof SETUP_FILE_SOURCE_DEFINITIONS)[number];
export type SetupFileSourcePath = SetupFileSource["path"];
export type SetupFileSectionId =
  (typeof SETUP_FILE_SECTION_DEFINITIONS)[number]["id"];

