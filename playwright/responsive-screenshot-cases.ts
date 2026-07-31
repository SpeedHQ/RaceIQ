export const RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

export const RESPONSIVE_PAGES = [
  { name: "home", path: "/" },
  { name: "fm23-landing", path: "/fm23" },
  { name: "fm23-sessions", path: "/fm23/sessions" },
  { name: "fm23-cars", path: "/fm23/cars" },
  { name: "fm23-tracks", path: "/fm23/tracks" },
  { name: "fm23-chats", path: "/fm23/chats" },
  { name: "f125-cars", path: "/f125/cars" },
  { name: "f125-tracks", path: "/f125/tracks" },
] as const;

export const RESPONSIVE_INTERACTION_CASES = [
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
] as const;
