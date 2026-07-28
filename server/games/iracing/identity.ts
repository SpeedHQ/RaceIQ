import { rememberIRacingIdentity } from "../../../shared/games/iracing";
import {
  getDiscoveredCarName,
  registerDiscoveredCar,
} from "../../db/discovered-cars";
import {
  getDiscoveredTrackName,
  registerDiscoveredTrack,
} from "../../db/discovered-tracks";
import type { IRacingSessionSnapshot } from "./source-frame";

/**
 * Accept identity only from the live SDK source. Parsers and import/replay
 * pipelines must remain pure so historical captures cannot rewrite live names.
 */
export async function registerLiveIRacingIdentity(
  session: IRacingSessionSnapshot,
): Promise<void> {
  const writes: Promise<void>[] = [];
  if (session.carId >= 0 && session.carName) {
    writes.push(
      registerDiscoveredCar("iracing", session.carId, session.carName),
    );
  }
  if (session.trackId >= 0 && session.trackName) {
    writes.push(
      registerDiscoveredTrack("iracing", session.trackId, session.trackName),
    );
  }
  await Promise.all(writes);

  const [carName, trackName] = await Promise.all([
    session.carId >= 0
      ? getDiscoveredCarName("iracing", session.carId)
      : undefined,
    session.trackId >= 0
      ? getDiscoveredTrackName("iracing", session.trackId)
      : undefined,
  ]);
  rememberIRacingIdentity({
    carId: session.carId,
    carName: carName ?? session.carName,
    trackId: session.trackId,
    trackName: trackName ?? session.trackName,
  });
}
