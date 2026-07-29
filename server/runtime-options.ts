import { IS_DEV } from "./env";

const ONBOARDING_FLAG = "--onboarding";

export type OnboardingOverride = boolean | null;

function parseBoolean(value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${ONBOARDING_FLAG} must be followed by true or false`);
}

export function parseOnboardingOverride(args: readonly string[]): OnboardingOverride {
  const inlineArg = args.find((arg) => arg.startsWith(`${ONBOARDING_FLAG}=`));
  if (inlineArg) {
    return parseBoolean(inlineArg.slice(ONBOARDING_FLAG.length + 1));
  }

  const flagIndex = args.indexOf(ONBOARDING_FLAG);
  if (flagIndex === -1) return null;
  return parseBoolean(args[flagIndex + 1]);
}

export function getOnboardingOverride(
  args: readonly string[] = process.argv,
  isDevelopment: boolean = IS_DEV,
): OnboardingOverride {
  if (!isDevelopment) return null;
  return parseOnboardingOverride(args);
}

export function withOnboardingOverride<T extends { onboardingComplete: boolean }>(
  settings: T,
  onboarding: OnboardingOverride = getOnboardingOverride(),
): T {
  if (onboarding === null) return settings;

  const onboardingComplete = !onboarding;
  if (settings.onboardingComplete === onboardingComplete) return settings;

  return { ...settings, onboardingComplete };
}
