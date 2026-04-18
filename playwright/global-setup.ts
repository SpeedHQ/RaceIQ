import { rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

// Reset the onboarding project's DATA_DIR before every run and pre-seed an
// empty settings.json so the compiled binary skips its first-run auto-open
// branch (which currently kills the compiled process on macOS). Onboarding
// still fires because `onboardingComplete` defaults to false in the schema.
export default async function globalSetup() {
  const dir = resolve(__dirname, "test-data");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "settings.json"), "{}");
}
