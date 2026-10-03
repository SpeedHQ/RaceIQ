import { initGameAdapters } from "@raceiq/shared/games/init";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { developmentReleaseFeatures } from "@raceiq/tooling/release/development-release-features";
import { initServerGameAdapters } from "../../src/games/init";
import { initMotecTargets } from "../../src/games/motec-init";
import { notifyDriverProfileLap } from "../../src/driver-profile/runner";

initGameAdapters(developmentReleaseFeatures);
initServerGameAdapters(developmentReleaseFeatures);
initMotecTargets();
registerDriverProfileLapNotifier(notifyDriverProfileLap);
