import { readRecordedTelemetry } from "../../src/session-capture/replay-packets";
import { getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { initServerGameAdapters } from "../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";

initServerGameAdapters(developmentReleaseFeatures);

const recordingPath = "C:/Users/acoop/Downloads/ac-evo-unknown-track-session17.bin.gz";
const { packets } = readRecordedTelemetry("ac-evo", recordingPath);
console.log("packets:", packets.length);
const last = packets.at(-1);
if (last) {
  const trackName = typeof last.trackId === "number" ? getAcEvoTrackName(last.trackId) : last.trackId;
  console.log("last packet:", JSON.stringify({
    carId: last.carId,
    trackId: last.trackId,
    trackName,
    trackNameFromSource: last.acEvoIdentity?.trackName,
    trackConfiguration: last.acEvoIdentity?.trackConfiguration,
  }));
}
