export const RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

type ResponsiveViewportName = (typeof RESPONSIVE_VIEWPORTS)[number]["name"];

interface ResponsivePage {
  name: string;
  path: string;
  viewports?: readonly ResponsiveViewportName[];
  readyText?: string;
  seedReadyText?: string;
  requiresSeed?: boolean;
}

const DESKTOP_ONLY = ["desktop"] as const;

export const RESPONSIVE_PAGES: readonly ResponsivePage[] = [
  { name: "home", path: "/" },
  { name: "fm23-landing", path: "/fm23" },
  { name: "fm23-live", path: "/fm23/live" },
  { name: "f125-live", path: "/f125/live" },
  { name: "acc-live", path: "/acc/live" },
  { name: "fm23-sessions", path: "/fm23/sessions" },
  { name: "fm23-analyse", path: "/fm23/analyse" },
  { name: "fm23-compare", path: "/fm23/compare" },
  { name: "fm23-cars", path: "/fm23/cars" },
  { name: "fm23-tracks", path: "/fm23/tracks" },
  { name: "fm23-track-detail", path: "/fm23/tracks/860/info", readyText: "Brand Hatch" },
  { name: "fm23-chats", path: "/fm23/chats" },
  { name: "fm23-driver", path: "/fm23/driver" },
  { name: "f125-experiments", path: "/f125/experiments", seedReadyText: "Demo setup experiment" },
  { name: "fm23-setups", path: "/fm23/setups" },
  { name: "acc-setups", path: "/acc/setups" },
  { name: "f125-cars", path: "/f125/cars" },
  { name: "f125-tracks", path: "/f125/tracks" },

  // Game-specific variants share responsive shells with cases above. Capture
  // each once at canonical desktop size to verify adapter data, branding, and
  // route-specific composition without a game × viewport explosion.
  { name: "f125-landing", path: "/f125", viewports: DESKTOP_ONLY },
  { name: "acc-landing", path: "/acc", viewports: DESKTOP_ONLY },
  { name: "ac-evo-landing", path: "/ac-evo", viewports: DESKTOP_ONLY },
  { name: "iracing-landing", path: "/iracing", viewports: DESKTOP_ONLY },
  { name: "fm23-live-pit", path: "/fm23/live/pit", viewports: DESKTOP_ONLY },
  { name: "ac-evo-live", path: "/ac-evo/live", viewports: DESKTOP_ONLY },
  { name: "iracing-live-driver", path: "/iracing/live/driver", viewports: DESKTOP_ONLY },
  { name: "iracing-live-pit", path: "/iracing/live/pit", viewports: DESKTOP_ONLY },
  { name: "acc-cars", path: "/acc/cars", viewports: DESKTOP_ONLY },
  { name: "ac-evo-cars", path: "/ac-evo/cars", viewports: DESKTOP_ONLY },
  { name: "iracing-cars", path: "/iracing/cars", viewports: DESKTOP_ONLY },
  { name: "acc-tracks", path: "/acc/tracks", viewports: DESKTOP_ONLY },
  { name: "ac-evo-tracks", path: "/ac-evo/tracks", viewports: DESKTOP_ONLY },
  { name: "iracing-tracks", path: "/iracing/tracks", viewports: DESKTOP_ONLY },
  { name: "f125-track-detail", path: "/f125/tracks/19/info", viewports: DESKTOP_ONLY, readyText: "Autodromo Hermanos Rodriguez" },
  { name: "acc-track-detail", path: "/acc/tracks/8/info", viewports: DESKTOP_ONLY, readyText: "Barcelona" },
  { name: "ac-evo-track-detail", path: "/ac-evo/tracks/14/info", viewports: DESKTOP_ONLY, readyText: "Barcelona" },
  { name: "iracing-track-detail", path: "/iracing/tracks/18/info", viewports: DESKTOP_ONLY, readyText: "Road America" },
  { name: "f125-setups", path: "/f125/setups", viewports: DESKTOP_ONLY },
  { name: "ac-evo-setups", path: "/ac-evo/setups", viewports: DESKTOP_ONLY },

  // Seeded data states. These cover real lap-heavy and experiment detail
  // compositions for every game.
  { name: "fm23-seeded-laps", path: "/fm23/tracks/5/laps", viewports: DESKTOP_ONLY, readyText: "Road America", requiresSeed: true },
  { name: "f125-seeded-laps", path: "/f125/tracks/19/laps", viewports: DESKTOP_ONLY, readyText: "Autodromo Hermanos Rodriguez", requiresSeed: true },
  { name: "acc-seeded-laps", path: "/acc/tracks/2/laps", viewports: DESKTOP_ONLY, readyText: "Brands Hatch", requiresSeed: true },
  { name: "ac-evo-seeded-laps", path: "/ac-evo/tracks/2/laps", viewports: DESKTOP_ONLY, readyText: "Brands Hatch", requiresSeed: true },
  { name: "iracing-seeded-laps", path: "/iracing/tracks/192/laps", viewports: DESKTOP_ONLY, readyText: "Daytona International Speedway", requiresSeed: true },
  { name: "fm23-track-setups", path: "/fm23/tracks/860/setups", viewports: DESKTOP_ONLY, readyText: "Brand Hatch" },
  { name: "f125-track-setups", path: "/f125/tracks/19/setups", viewports: DESKTOP_ONLY, readyText: "Autodromo Hermanos Rodriguez" },
  { name: "f125-track-guide", path: "/f125/tracks/19/guide", viewports: DESKTOP_ONLY, readyText: "Autodromo Hermanos Rodriguez" },
  { name: "acc-track-setups", path: "/acc/tracks/2/setups", viewports: DESKTOP_ONLY, readyText: "Brands Hatch" },
  { name: "acc-track-guide", path: "/acc/tracks/2/guide", viewports: DESKTOP_ONLY, readyText: "Brands Hatch" },
  { name: "f125-experiment-detail", path: "/f125/experiments/1", viewports: DESKTOP_ONLY, readyText: "Demo setup experiment", requiresSeed: true },
  { name: "f125-experiment-review", path: "/f125/experiments/1/review?versionId=2", viewports: DESKTOP_ONLY, readyText: "Post-lap", requiresSeed: true },
  { name: "iracing-raw", path: "/iracing/raw", viewports: DESKTOP_ONLY },
];

interface ResponsiveInteractionCase {
  name: string;
  path: string;
  kind: string;
  mobileOnly: boolean;
  viewports?: readonly ResponsiveViewportName[];
}

export const RESPONSIVE_INTERACTION_CASES: readonly ResponsiveInteractionCase[] = [
  {
    name: "nav-drawer-open",
    path: "/fm23",
    kind: "nav-drawer",
    mobileOnly: true,
  },
  {
    name: "settings-modal",
    path: "/",
    kind: "settings",
    mobileOnly: false,
  },
  {
    name: "settings-language-menu",
    path: "/",
    kind: "settings-language",
    mobileOnly: false,
  },
  {
    name: "analyse-data-panel-loaded",
    path: "/f125/analyse",
    kind: "analyse-data-panel-loaded",
    mobileOnly: false,
    viewports: DESKTOP_ONLY,
  },
  {
    name: "analyse-actions-menu",
    path: "/fm23/analyse",
    kind: "analyse-actions",
    mobileOnly: false,
  },
] as const;

export const RESPONSIVE_DEVICE_CASES = [
  {
    name: "pixel-7-touch-shell",
    project: "mobile-device",
    path: "/fm23",
    expectedViewport: { width: 412, height: 839 },
  },
  {
    name: "ipad-gen-7-touch-shell",
    project: "tablet-device",
    path: "/fm23",
    expectedViewport: { width: 810, height: 1080 },
  },
] as const;

export type ResponsiveDeviceCase = (typeof RESPONSIVE_DEVICE_CASES)[number];

export const RESPONSIVE_SCREENSHOT_COUNT =
  RESPONSIVE_VIEWPORTS.reduce((count, viewport) => count + RESPONSIVE_PAGES.filter((page) => !page.viewports || page.viewports.includes(viewport.name)).length, 0) +
  RESPONSIVE_VIEWPORTS.reduce((count, viewport) => count + RESPONSIVE_INTERACTION_CASES.filter((screenshotCase) => (!screenshotCase.viewports || screenshotCase.viewports.includes(viewport.name)) && (!screenshotCase.mobileOnly || viewport.width < 768)).length, 0);
