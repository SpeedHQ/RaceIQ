// Client-side preferences stored in localStorage

const STEER_LOCK_KEY = "forza-steer-lock";
const WHEEL_STYLE_KEY = "forza-wheel-style";
const SOUND_ENABLED_KEY = "forza-sound-enabled";
const SOUND_VOLUME_KEY = "forza-sound-volume";
const SOUND_TYPE_KEY = "forza-sound-type";
const SOUND_URL_KEY = "forza-sound-url";

export function getSteeringLock(): number {
  const val = localStorage.getItem(STEER_LOCK_KEY);
  return val ? parseInt(val, 10) : 900;
}

export const DEFAULT_WHEEL = "/wheels/Simple.svg";

export function getWheelStyle(): string {
  return localStorage.getItem(WHEEL_STYLE_KEY) || DEFAULT_WHEEL;
}

export function getSoundEnabled(): boolean {
  const val = localStorage.getItem(SOUND_ENABLED_KEY);
  return val === null ? true : val === "true"; // default on
}

export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(SOUND_ENABLED_KEY, String(enabled));
}

export function getSoundVolume(): number {
  const val = localStorage.getItem(SOUND_VOLUME_KEY);
  return val ? parseFloat(val) : 0.15; // default 15%
}

export function setSoundVolume(volume: number): void {
  localStorage.setItem(SOUND_VOLUME_KEY, String(Math.max(0, Math.min(1, volume))));
}

export const SOUND_PRESETS = [
  { id: "beep-2", label: "Beep Short" },
  { id: "url", label: "Custom URL" },
] as const;

export type SoundType = string; // preset id or "url"

export function getSoundType(): string {
  const val = localStorage.getItem(SOUND_TYPE_KEY);
  return val ?? "beep-2";
}

export function setSoundType(type: SoundType): void {
  localStorage.setItem(SOUND_TYPE_KEY, type);
}

export function getSoundUrl(): string {
  return localStorage.getItem(SOUND_URL_KEY) ?? "";
}

export function setSoundUrl(url: string): void {
  localStorage.setItem(SOUND_URL_KEY, url);
}

export { STEER_LOCK_KEY, WHEEL_STYLE_KEY };
