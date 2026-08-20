// Packet/native field mapping and catalog group construction.
import {
  CATEGORY_META,
} from "./semantic-definitions";
import {
  unavailable,
  memberPath,
  objectProperties,
  isStaticPlaceholder,
} from "./ast-discovery";
import type {
  AstNode,
  AvailableLink,
  CatalogGroup,
  FieldSet,
  GameId,
  GameLink,
  ParserOutput,
} from "./model";
import { SETUP_GROUP_DEFINITIONS } from "../../shared/racing/setups/catalog/groups";
const SOURCE_ROOTS: Partial<Record<GameId, Record<string, string>>> = {
  "f1-2025": {
    m: "F1.Motion",
    ct: "F1.CarTelemetry",
    ld: "F1.LapData",
    cs: "F1.CarStatus",
    cd: "F1.CarDamage",
    mx: "F1.MotionEx",
    sess: "F1.Session",
    header: "F1.Header",
  },
  acc: {
    PHYSICS: "ACC.Physics",
    GRAPHICS: "ACC.Graphics",
    STATIC: "ACC.Static",
  },
  "ac-evo": {
    PHYSICS: "AC-Evo.Physics",
    GRAPHICS: "AC-Evo.Graphics",
    STATIC: "AC-Evo.Static",
    PHYSICS_EVO: "AC-Evo.Physics",
    GRAPHICS_EVO: "AC-Evo.Graphics",
    STATIC_EVO: "AC-Evo.Static",
  },
  iracing: {
    session: "iRacing.SessionInfo",
    source: "iRacing.SourceFrame",
  },
};

const PACKET_SOURCE_OVERRIDES: Partial<
  Record<GameId, Record<string, string[]>>
> = {
  "f1-2025": {
    CarOrdinal: ["F1.Participants.player.teamId"],
    NumCylinders: ["RaceIQ.ParserConstant.NumCylinders"],
  },
  acc: {
    CarOrdinal: ["ACC.Static.carModel"],
    TrackOrdinal: ["ACC.Static.track"],
  },
  "ac-evo": {
    CarOrdinal: ["AC-Evo.Graphics.car_model"],
    TrackOrdinal: [
      "AC-Evo.Static.track",
      "AC-Evo.Static.track_configuration",
    ],
  },
  iracing: {
    PositionX: ["iRacing.Lat", "iRacing.Lon"],
    PositionY: ["iRacing.Lat", "iRacing.Lon", "iRacing.Alt"],
    PositionZ: ["iRacing.Lat", "iRacing.Lon"],
  },
};

const UNAVAILABLE_PACKET_FIELDS: Partial<
  Record<GameId, Record<string, string>>
> = {
  "f1-2025": {
    DrivetrainType:
      "F1 parser emits a fixed drivetrain enum rather than a simulator-provided vehicle value.",
    IsRaceOn:
      "F1 parser emits constant 1 rather than a distinct simulator race-active value.",
  },
  acc: {
    DrivetrainType:
      "ACC parser assumes rear-wheel drive rather than reading drivetrain from shared memory.",
  },
  "ac-evo": {
    DrivetrainType:
      "AC Evo parser assumes rear-wheel drive rather than reading drivetrain from shared memory.",
  },
  iracing: {
    DrivetrainType:
      "iRacing normalizer emits a fixed drivetrain enum rather than a source-frame value.",
  },
};

function nativeSources(
  gameId: GameId,
  node: AstNode | undefined,
  variables: Map<string, AstNode>,
  seen = new Set<string>(),
): string[] {
  if (!node) return [];
  const sources = new Set<string>();
  const roots = SOURCE_ROOTS[gameId] ?? {};

  function resolveVariableMember(
    root: string,
    members: readonly string[],
  ): AstNode | undefined {
    let current = variables.get(root);
    for (const member of members) {
      while (
        current &&
        [
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TypeCastExpression",
          "ParenthesizedExpression",
        ].includes(current.type)
      ) {
        current = current.expression;
      }
      if (current?.type !== "ObjectExpression") return undefined;
      current = objectProperties(current).get(member);
    }
    return current;
  }

  function inspect(current: unknown): void {
    if (!current || typeof current !== "object") return;
    const value = current as AstNode;

    if (
      value.type === "CallExpression" &&
      value.callee?.type === "Identifier" &&
      ["scalar", "booleanValue", "bool"].includes(value.callee.name) &&
      value.arguments?.[1]?.type === "StringLiteral"
    ) {
      sources.add(`iRacing.${value.arguments[1].value}`);
    }

    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const path = memberPath(value);
      if (path) {
        const [root, ...rest] = path.split(".");
        if (roots[root] && rest.length > 0) {
          sources.add(`${roots[root]}.${rest.join(".").replace(/\.offset$/, "")}`);
          return;
        }
        if (rest.length > 0) {
          const resolved = resolveVariableMember(root, rest);
          if (resolved) {
            inspect(resolved);
            return;
          }
        }
      }
    }

    if (value.type === "Identifier" && variables.has(value.name) && !seen.has(value.name)) {
      seen.add(value.name);
      inspect(variables.get(value.name));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      ) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) inspect(item);
      } else {
        inspect(child);
      }
    }
  }

  inspect(node);
  return [...sources].filter(
    (source) =>
      !source.endsWith(".offset") &&
      !/\.(readFloatLE|readInt32LE|readUInt)/.test(source),
  );
}

function specialIRacingSources(field: string): string[] | undefined {
  const rawWheel = field.match(
    /(FL|FR|RL|RR|FrontLeft|FrontRight|RearLeft|RearRight)$/,
  )?.[1];
  const wheel = rawWheel
    ? {
        FL: "FL",
        FR: "FR",
        RL: "RL",
        RR: "RR",
        FrontLeft: "FL",
        FrontRight: "FR",
        RearLeft: "RL",
        RearRight: "RR",
      }[rawWheel]
    : undefined;
  if (!wheel) return undefined;
  const corner = { FL: "LF", FR: "RF", RL: "LR", RR: "RR" }[wheel];
  if (field.startsWith("TireWear")) {
    return ["L", "M", "R"].map((band) => `iRacing.${corner}wear${band}`);
  }
  if (field.startsWith("TirePressure")) {
    return [`iRacing.${corner}coldPressure`];
  }
  if (field.startsWith("TireTemp") || field.startsWith("TireCarcassTemp")) {
    const band = field.includes("Left")
      ? ["L"]
      : field.includes("Middle")
        ? ["M"]
        : field.includes("Right")
          ? ["R"]
          : ["L", "M", "R"];
    return band.map((part) => `iRacing.${corner}tempC${part}`);
  }
  return undefined;
}

function expressionText(output: ParserOutput, node: AstNode): string {
  if (typeof node.start !== "number" || typeof node.end !== "number") return "";
  return output.source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
}

function expandedExpressionText(
  output: ParserOutput,
  node: AstNode,
  seen = new Set<string>(),
): string {
  const expressions = [expressionText(output, node)];
  let candidate = node;
  while (
    candidate &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
      "ParenthesizedExpression",
    ].includes(candidate.type)
  ) {
    candidate = candidate.expression;
  }
  if (candidate?.type === "Identifier") {
    const initializer = output.variables.get(candidate.name);
    if (initializer && !seen.has(candidate.name)) {
      seen.add(candidate.name);
      expressions.push(expandedExpressionText(output, initializer, seen));
    }
  }
  return [...new Set(expressions.filter(Boolean))].join(" => ");
}

function packetNativeMetadata(
  gameId: GameId,
  key: string,
  canonicalUnit: string,
): { nativeUnit: string; normalization?: string } {
  if (gameId === "fm-2023" && key.startsWith("TireTemp")) {
    return {
      nativeUnit: "°F",
      normalization: "(fahrenheit - 32) * 5 / 9",
    };
  }
  if (gameId === "f1-2025" && key === "Speed") {
    return { nativeUnit: "km/h", normalization: "kilometres per hour / 3.6" };
  }
  if ((gameId === "acc" || gameId === "ac-evo") && key === "Speed") {
    return { nativeUnit: "km/h", normalization: "kilometres per hour / 3.6" };
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    ["BestLap", "LastLap", "CurrentLap"].includes(key)
  ) {
    return { nativeUnit: "ms", normalization: "milliseconds / 1000" };
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    ["Accel", "Brake", "Steer"].includes(key)
  ) {
    return {
      nativeUnit: "ratio",
      normalization: key === "Steer" ? "ratio * 127 and round" : "ratio * 255 and round",
    };
  }
  if (gameId === "f1-2025" && ["Accel", "Brake", "Steer"].includes(key)) {
    return {
      nativeUnit: "ratio",
      normalization: key === "Steer" ? "ratio * 127 and round" : "ratio * 255 and round",
    };
  }
  if (gameId === "f1-2025" && key === "Clutch") {
    return { nativeUnit: "%", normalization: "percentage * 2.55 and round" };
  }
  if (gameId === "iracing" && ["Accel", "Brake", "Clutch"].includes(key)) {
    return { nativeUnit: "%", normalization: "0-1 SDK value * 255 and round" };
  }
  if (gameId === "iracing" && key === "Speed") {
    return {
      nativeUnit: "m/s",
      normalization: "clamp native m/s speed to non-negative canonical m/s",
    };
  }
  if (gameId === "iracing" && key === "Steer") {
    return {
      nativeUnit: "rad",
      normalization: "steering angle / steering maximum, clamp to -1..1, then * 127",
    };
  }
  if (gameId === "iracing" && key === "TireWear") {
    return {
      nativeUnit: "% tread remaining",
      normalization: "1 - minimum(left, middle, right tread remaining)",
    };
  }
  if (gameId === "iracing" && key === "TirePressure") {
    return { nativeUnit: "kPa", normalization: "kilopascals * 0.1450377377" };
  }
  return { nativeUnit: canonicalUnit };
}


function isPacketSemanticDerivation(
  gameId: GameId,
  key: string,
  expressions: readonly string[],
): boolean {
  if (
    gameId === "iracing" &&
    (key === "CurrentLap" || key === "DistanceTraveled" || key === "TireWear")
  ) {
    return true;
  }
  if (
    gameId === "f1-2025" &&
    (key === "Power" || key === "TireCombinedSlip")
  ) {
    return true;
  }
  return expressions.some((expression) =>
    /integrateDistance|tireWear|sector boundary|lap start/i.test(
      expression,
    ),
  );
}

function isPacketRepresentationNormalization(
  gameId: GameId,
  key: string,
  native: { normalization?: string },
  expressions: readonly string[],
): boolean {
  if (native.normalization) return true;
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    (key === "CarOrdinal" || key === "TrackOrdinal")
  ) {
    return true;
  }
  return expressions.some((expression) =>
    /input255|canonicalGear|clamp|Math\.(?:round|trunc)|Boolean\(|===|!==|\?/.test(
      expression,
    ),
  );
}

function classifyPacketMapping(
  gameId: GameId,
  key: string,
  native: { normalization?: string },
  expressions: readonly string[],
): AvailableLink["kind"] {
  if (
    (gameId === "iracing" &&
      (key === "TireTemp" || key === "TireCarcassTemp")) ||
    (gameId === "acc" && key === "WeatherType") ||
    (gameId === "f1-2025" && key === "WheelRotationSpeed")
  ) {
    return "simplified";
  }
  if (isPacketSemanticDerivation(gameId, key, expressions)) return "derived";
  if (
    isPacketRepresentationNormalization(gameId, key, native, expressions)
  ) {
    return "normalized";
  }
  if (
    expressions.some((expression) =>
      /[+\-*/?:]|Math\./.test(expression),
    )
  ) {
    return "derived";
  }
  return "direct";
}

function packetGameLink(
  gameId: GameId,
  set: FieldSet,
  output: ParserOutput,
  unit: string,
): GameLink {
  const explicitlyUnavailable = UNAVAILABLE_PACKET_FIELDS[gameId]?.[set.key];
  if (explicitlyUnavailable) {
    return unavailable("parser-placeholder", explicitlyUnavailable);
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    set.key === "CurrentRaceTime"
  ) {
    return unavailable(
      "parser-placeholder",
      `${gameId} currently copies current-lap time into CurrentRaceTime; no distinct session elapsed time is populated.`,
    );
  }
  if (
    gameId === "ac-evo" &&
    /^TireSurfaceTemp(Inner|Middle|Outer)$/.test(set.key)
  ) {
    return unavailable(
      "source-not-populated",
      "AC Evo v0.6 reserves matching fields, but fixture-backed pages report zero instead of live surface-band temperatures.",
    );
  }
  const fields = set.fields;
  if (fields.every((field) => isStaticPlaceholder(output.properties.get(field)))) {
    return unavailable(
      "parser-placeholder",
      `${gameId} parser fills this value with a placeholder because source does not provide it.`,
    );
  }

  const sourceOverride = PACKET_SOURCE_OVERRIDES[gameId]?.[set.key];
  const sourcesByField = fields.map((field) => {
    if (sourceOverride) return sourceOverride;
    if (gameId === "fm-2023") return [`ForzaDataOut.${field}`];
    if (gameId === "iracing") {
      const special = specialIRacingSources(field);
      if (special) return special;
    }
    return nativeSources(
      gameId,
      output.properties.get(field),
      output.variables,
    );
  });
  let allSources = [...new Set(sourcesByField.flat())];
  if (allSources.length === 0) {
    allSources = fields.map((field) =>
      field === "TimestampMS"
        ? "RaceIQ.SystemClock"
        : `RaceIQ.ParserState.${field}`,
    );
    for (const [index, sources] of sourcesByField.entries()) {
      if (sources.length === 0) sources.push(allSources[index]);
    }
  }
  const expressions = fields.map((field) => {
    const value = output.properties.get(field);
    return value ? expandedExpressionText(output, value) : "";
  });
  const native = packetNativeMetadata(gameId, set.key, unit);
  const directIRacingCarcassBand =
    gameId === "iracing" &&
    /^TireCarcassTemp(Left|Middle|Right)$/.test(set.key);
  const mappingKind = directIRacingCarcassBand
    ? "direct"
    : classifyPacketMapping(gameId, set.key, native, expressions);
  const sourceShape =
    set.shape === "per-wheel"
      ? Object.fromEntries(
          ["FL", "FR", "RL", "RR"].map((wheel, index) => [
            wheel,
            sourcesByField[index],
          ]),
        )
      : allSources;
  const tireAverageSimplification =
    mappingKind === "simplified" &&
    gameId === "iracing" &&
    (set.key === "TireTemp" || set.key === "TireCarcassTemp");
  const normalization = tireAverageSimplification
    ? "average available left, middle, and right carcass temperatures per tire"
    : native.normalization ?? [...new Set(expressions)].join(" | ");
  let description =
    allSources.length > 0
      ? `${gameId} maps ${allSources.length} native source channel${allSources.length === 1 ? "" : "s"} into this value.`
      : `${gameId} provides this value from parser/session state.`;
  let limitations: readonly string[] | undefined;
  if (tireAverageSimplification) {
    description =
      "Averages available iRacing left, middle, and right carcass-temperature bands per tire.";
    limitations = [
      "Averaging removes across-tread temperature-gradient detail.",
    ];
  } else if (
    gameId === "iracing" &&
    (set.key === "PositionX" ||
      set.key === "PositionY" ||
      set.key === "PositionZ")
  ) {
    description =
      "Projects disk-only iRacing IBT geographic coordinates into a local metric position.";
    limitations = [
      "Available only in imported IBT recordings; iRacing live shared memory does not publish geographic coordinates.",
    ];
  } else if (gameId === "iracing" && set.key === "Yaw") {
    description =
      "Uses north-referenced heading from imported IBT rows and simulator-relative yaw otherwise.";
  } else if (gameId === "acc" && set.key === "WeatherType") {
    description =
      "Infers wet weather from rain-tyre selection rather than observing weather directly.";
    limitations = [
      "Rain-tyre selection is a lossy weather proxy and cannot distinguish dry conditions or weather intensity.",
    ];
  } else if (gameId === "f1-2025" && set.key === "WheelRotationSpeed") {
    description =
      "Estimates wheel angular speed using an assumed 0.36 m radius and falls back to vehicle speed when per-wheel motion is unavailable.";
    limitations = [
      "Assumed wheel radius and vehicle-speed fallback cannot preserve actual per-wheel rotation.",
    ];
  }

  return {
    kind: mappingKind,
    nativeUnit: native.nativeUnit,
    sources: sourceShape,
    freshness:
      gameId === "f1-2025" && set.key === "NumCylinders"
        ? "static"
        : gameId === "iracing" && /Tire.*Temp|TireWear|TirePressure/.test(set.key)
        ? "pit-snapshot"
        : "continuous",
    ...(normalization && mappingKind !== "direct" ? { normalization } : {}),
    description,
    ...(limitations ? { limitations } : {}),
  };
}

function nativeFuelUnit(gameId: GameId): string {
  if (gameId === "fm-2023" || gameId === "f1-2025") return "fraction";
  return "L";
}

function ensureCategoryGroups(groups: Map<string, CatalogGroup>): void {
  for (const [id, [label, description]] of Object.entries(CATEGORY_META)) {
    groups.set(id, { id, label, description, children: [] });
  }
  groups.set("tire.temperature", {
    id: "tire.temperature",
    label: "Tire temperature",
    description:
      "Temperature measurements for each tire, from representative values down to carcass and tread-surface detail.",
    parentId: "tires",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("tire.temperature.carcass", {
    id: "tire.temperature.carcass",
    label: "Carcass temperature",
    description:
      "Internal tire temperatures. Sources may provide one core value or multiple carcass bands.",
    parentId: "tire.temperature",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("tire.temperature.surface", {
    id: "tire.temperature.surface",
    label: "Surface temperature",
    description:
      "Tread-surface temperatures, either representative or split into inner, middle, and outer bands.",
    parentId: "tire.temperature",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("weather.configured", {
    id: "weather.configured",
    label: "Configured weather",
    description: "Weather values configured for session, distinct from current measured conditions.",
    parentId: "weather",
    children: [],
  });
  groups.set("engine.shift-light", {
    id: "engine.shift-light",
    label: "Shift-light thresholds",
    description: "Engine-speed thresholds controlling staged shift-light indicators.",
    parentId: "engine",
    canonicalUnit: "rpm",
    children: [],
  });
  groups.set("motion.driver-head-position", {
    id: "motion.driver-head-position",
    label: "Driver head position",
    description: "Driver head location relative to vehicle reference frame.",
    parentId: "motion",
    canonicalUnit: "m",
    children: [],
  });
  groups.set("diagnostics.camera", {
    id: "diagnostics.camera",
    label: "Camera state",
    description: "Simulator camera groups, definitions, and active focus state.",
    parentId: "diagnostics",
    children: [],
  });
  groups.set("diagnostics.radio", {
    id: "diagnostics.radio",
    label: "Radio state",
    description: "Simulator radio selection, channels, permissions, and transmit state.",
    parentId: "diagnostics",
    children: [],
  });
  groups.set("identity.track", {
    id: "identity.track",
    label: "Track identity",
    description: "Track name, configuration, dimensions, and source identifiers.",
    parentId: "identity",
    children: [],
  });
  groups.set("race.competitor", {
    id: "race.competitor",
    label: "Competitors",
    description: "Per-competitor identity, live timing, and classified results.",
    parentId: "race",
    children: [],
  });
  groups.set("race.competitor.identity", {
    id: "race.competitor.identity",
    label: "Competitor identity",
    description: "Driver, team, vehicle, and class fields for each competitor.",
    parentId: "race.competitor",
    children: [],
  });
  groups.set("race.competitor.results", {
    id: "race.competitor.results",
    label: "Competitor results",
    description: "Running and classified race-result fields for each competitor.",
    parentId: "race.competitor",
    children: [],
  });
  groups.set("race.competitor.timing", {
    id: "race.competitor.timing",
    label: "Competitor timing",
    description: "Lap times, gaps, and split times for each competitor.",
    parentId: "race.competitor",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("race.pit-service", {
    id: "race.pit-service",
    label: "Pit service",
    description: "Requested pit work, tire changes, fuel addition, and repair state.",
    parentId: "race",
    children: [],
  });
  groups.set("timing.sector", {
    id: "timing.sector",
    label: "Sector timing",
    description:
      "Native sector detail and comparable RaceIQ sector values, preserving variable sector counts.",
    parentId: "timing",
    children: [],
  });
  groups.set("timing.sector.layout", {
    id: "timing.sector.layout",
    label: "Sector layout",
    description: "Ordered sector identifiers and lap-position boundaries.",
    parentId: "timing.sector",
    children: [],
  });
  groups.set("timing.sector.current-lap", {
    id: "timing.sector.current-lap",
    label: "Current lap sectors",
    description: "Sector timing values for lap currently in progress.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.last-lap", {
    id: "timing.sector.last-lap",
    label: "Last lap sectors",
    description: "Sector timing values for most recently completed lap.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.lap-history", {
    id: "timing.sector.lap-history",
    label: "Per-lap sector history",
    description: "Sector timing keyed to specific completed lap numbers.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.competitor-best", {
    id: "timing.sector.competitor-best",
    label: "Competitor best sectors",
    description: "Best sector times for every competitor in field.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.competitor-last", {
    id: "timing.sector.competitor-last",
    label: "Competitor last sectors",
    description: "Most recent sector times for every competitor in field.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    children: [],
  });
  for (const group of SETUP_GROUP_DEFINITIONS) {
    groups.set(group.id, {
      ...group,
      children: [],
    });
  }
}

function attachChild(groups: Map<string, CatalogGroup>, parentId: string, childId: string): void {
  const parent = groups.get(parentId);
  if (!parent) throw new Error(`Missing parent group ${parentId}`);
  if (!parent.children.includes(childId)) parent.children.push(childId);
}
export {
  SOURCE_ROOTS,
  PACKET_SOURCE_OVERRIDES,
  UNAVAILABLE_PACKET_FIELDS,
  nativeSources,
  specialIRacingSources,
  expressionText,
  expandedExpressionText,
  packetNativeMetadata,
  isPacketSemanticDerivation,
  isPacketRepresentationNormalization,
  classifyPacketMapping,
  packetGameLink,
  nativeFuelUnit,
  ensureCategoryGroups,
  attachChild,
};