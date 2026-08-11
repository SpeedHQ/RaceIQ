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

export type SetupFileGameId = "acc" | "ac-evo";

export type SetupFormTab =
  | "Tyres"
  | "Electronics"
  | "Fuel & strategy"
  | "Suspension"
  | "Dampers"
  | "Aero";

export type SetupFieldCardinality =
  | { kind: "scalar" }
  | {
      kind: "fixed";
      count: 2 | 4;
      ordering: readonly string[];
    };

export interface SetupFileSectionMetadata {
  label: string;
  description: string;
  tab: SetupFormTab;
  games: readonly SetupFileGameId[];
}

export interface SetupFileSectionDefinition extends SetupFileSectionMetadata {
  id: string;
}

export interface SetupFileSourceMetadata extends SetupSourceMapping {
  label: string;
  description: string;
  cardinality: SetupFieldCardinality;
  hint?: string;
  step?: number;
  min?: number;
}

export interface SetupFileSourceDefinition extends SetupFileSourceMetadata {
  path: string;
}

export type SetupFileSourceTree = Record<
  string,
  Record<
    string,
    SetupFileSectionMetadata & {
      fields: Record<string, SetupFileSourceMetadata>;
    }
  >
>;

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
