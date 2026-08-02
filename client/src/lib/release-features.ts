import { releaseFeatureFlags } from "@shared/release-feature-flags";
import { isDevelopment } from "./env";

export const clientReleaseFeatures = releaseFeatureFlags(isDevelopment);
