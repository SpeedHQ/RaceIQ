import { resolve } from "node:path";
import { releaseFeatureFlags } from "../shared/release-feature-flags";

const values = new Map<string, string>();
const contents = await Bun.file(resolve(import.meta.dir, "..", ".env.development")).text();
for (const line of contents.split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
}

export const developmentReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: values.get("RACEIQ_FEATURE_F1_EXPERIMENTS"),
  RACEIQ_FEATURE_IRACING_ADAPTER: values.get("RACEIQ_FEATURE_IRACING_ADAPTER"),
});
