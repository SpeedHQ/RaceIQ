export const DEV_ONBOARDING_COMPLETE_KEY = "raceiq:dev-onboarding-complete";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function enableDevOnboardingCompletion(storage: StorageWriter): void {
  storage.setItem(DEV_ONBOARDING_COMPLETE_KEY, "1");
}

export function hasDevOnboardingCompletion(isDevelopment: boolean, storage: StorageReader): boolean {
  return isDevelopment && storage.getItem(DEV_ONBOARDING_COMPLETE_KEY) === "1";
}

export function withDevOnboardingCompletion<T extends { onboardingComplete?: boolean }>(settings: T, isDevelopment: boolean, storage: StorageReader): T {
  if (settings.onboardingComplete || !hasDevOnboardingCompletion(isDevelopment, storage)) {
    return settings;
  }

  return { ...settings, onboardingComplete: true };
}

export function normalizeDevTarget(value: unknown): string {
  if (typeof value !== "string") return "/";

  const target = value.trim();
  if (!target.startsWith("/") || target.startsWith("//")) return "/";

  const url = new URL(target, "http://raceiq.localhost");
  if (url.pathname === "/dev/open") return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}
