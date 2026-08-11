import { m } from "@/paraglide/messages";

export const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "games", label: "Games" },
  { id: "connection", label: "Connection" },
  { id: "wheel", label: "Wheel" },
  { id: "speed", label: "Units" },
  { id: "sound", label: "Sound" },
  { id: "storage", label: "Storage" },
  { id: "ai", label: "AI Analysis" },
  { id: "developer", label: "Developer", devOnly: true },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

export type SectionId = (typeof NAV_ITEMS)[number]["id"];

export const NAV_LABELS: Record<SectionId, () => string> = {
  general: m.label_general,
  games: m.label_games,
  connection: m.label_connection,
  wheel: m.label_wheel,
  speed: m.label_units,
  sound: m.label_sound,
  storage: m.settings_nav_storage,
  ai: m.label_ai_analysis,
  developer: m.settings_nav_developer,
  diagnostics: m.label_diagnostics,
  updates: m.label_updates,
  about: m.label_about,
};
