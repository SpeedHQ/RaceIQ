export type SeededFeature = "landing" | "live" | "sessions" | "compare" | "analyse" | "chats" | "tracks" | "cars" | "raw" | "driver" | "experiments" | "setups" | "track-info" | "track-laps";

export type SeededGame = {
  gameId: "fm-2023" | "f1-2025" | "acc" | "ac-evo" | "iracing";
  prefix: "fm23" | "f125" | "acc" | "ac-evo" | "iracing";
  name: string;
  trackOrdinal: number;
  trackName: string;
  supportedFeatures: readonly SeededFeature[];
  unsupportedFeatures: readonly SeededFeature[];
};

export interface SeededGlobalRouteCase {
  readonly label: string;
  readonly path: string;
}

export type SeededRouteCase = {
  game: SeededGame;
  feature: SeededFeature;
  label: string;
  path: string;
  expectedPath?: string;
  trackHeading?: string;
};

const BASE_FEATURES = ["landing", "live", "sessions", "compare", "analyse", "chats", "tracks", "cars", "raw", "track-info", "track-laps"] as const satisfies readonly SeededFeature[];

const DRIVER_FEATURES = ["driver"] as const satisfies readonly SeededFeature[];
const SETUP_FEATURES = ["setups"] as const satisfies readonly SeededFeature[];
const EXPERIMENT_FEATURES = ["experiments"] as const satisfies readonly SeededFeature[];

export const SEEDED_GAME_CASES: readonly SeededGame[] = [
  {
    gameId: "fm-2023",
    prefix: "fm23",
    name: "Forza Motorsport 2023",
    trackOrdinal: 5,
    trackName: "Road America",
    supportedFeatures: [...BASE_FEATURES, ...DRIVER_FEATURES, ...SETUP_FEATURES],
    unsupportedFeatures: [...EXPERIMENT_FEATURES],
  },
  {
    gameId: "f1-2025",
    prefix: "f125",
    name: "F1 2025",
    trackOrdinal: 19,
    trackName: "Autodromo Hermanos Rodriguez",
    supportedFeatures: [...BASE_FEATURES, ...DRIVER_FEATURES, ...SETUP_FEATURES, ...EXPERIMENT_FEATURES],
    unsupportedFeatures: [],
  },
  {
    gameId: "acc",
    prefix: "acc",
    name: "Assetto Corsa Competizione",
    trackOrdinal: 2,
    trackName: "Brands Hatch",
    supportedFeatures: [...BASE_FEATURES, ...DRIVER_FEATURES, ...SETUP_FEATURES, ...EXPERIMENT_FEATURES],
    unsupportedFeatures: [],
  },
  {
    gameId: "ac-evo",
    prefix: "ac-evo",
    name: "Assetto Corsa EVO",
    trackOrdinal: 2,
    trackName: "Brands Hatch",
    supportedFeatures: [...BASE_FEATURES, ...DRIVER_FEATURES, ...SETUP_FEATURES, ...EXPERIMENT_FEATURES],
    unsupportedFeatures: [],
  },
  {
    gameId: "iracing",
    prefix: "iracing",
    name: "iRacing",
    trackOrdinal: 192,
    trackName: "Daytona International Speedway",
    supportedFeatures: BASE_FEATURES,
    unsupportedFeatures: [...DRIVER_FEATURES, ...SETUP_FEATURES, ...EXPERIMENT_FEATURES],
  },
] as const;

const FEATURE_LABELS: Record<SeededFeature, string> = {
  landing: "landing",
  live: "live",
  sessions: "sessions",
  compare: "compare",
  analyse: "analyse",
  chats: "chats",
  tracks: "tracks",
  cars: "cars",
  raw: "raw telemetry",
  driver: "driver",
  experiments: "experiments",
  setups: "setups",
  "track-info": "track info",
  "track-laps": "track laps",
};

function routeFor(game: SeededGame, feature: SeededFeature): Omit<SeededRouteCase, "game" | "feature" | "label"> {
  switch (feature) {
    case "landing":
      return { path: `/${game.prefix}` };
    case "live":
      return game.prefix === "iracing" ? { path: "/iracing/live", expectedPath: "/iracing/live/driver" } : { path: `/${game.prefix}/live` };
    case "track-info":
      return { path: `/${game.prefix}/tracks/${game.trackOrdinal}/info`, trackHeading: game.trackName };
    case "track-laps":
      return { path: `/${game.prefix}/tracks/${game.trackOrdinal}/laps`, trackHeading: game.trackName };
    default:
      return { path: `/${game.prefix}/${feature}` };
  }
}

export const SEEDED_ROUTE_CASES: readonly SeededRouteCase[] = SEEDED_GAME_CASES.flatMap((game) =>
  game.supportedFeatures.map((feature) => ({
    game,
    feature,
    label: FEATURE_LABELS[feature],
    ...routeFor(game, feature),
  })),
);

export const SEEDED_GLOBAL_ROUTE_CASES: readonly SeededGlobalRouteCase[] = [
  { label: "home", path: "/" },
  { label: "dash catalogue", path: "/dash" },
  { label: "combo dash 1", path: "/dash/combo-1" },
  { label: "combo dash 2", path: "/dash/combo-2" },
  { label: "developer tools", path: "/dev" },
];
