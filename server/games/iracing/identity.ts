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
 * Persist identity accepted at an explicit source boundary. The registry keeps
 * the first name observed for each native ordinal, so a later recording cannot
 * silently rename an existing car or track.
 */
async function registerAcceptedIRacingIdentity(
  identity: Pick<
    IRacingSessionSnapshot,
    "carId" | "carName" | "trackId" | "trackName"
  >,
): Promise<void> {
  const writes: Promise<void>[] = [];
  if (identity.carId >= 0 && identity.carName) {
    writes.push(
      registerDiscoveredCar("iracing", identity.carId, identity.carName),
    );
  }
  if (identity.trackId >= 0 && identity.trackName) {
    writes.push(
      registerDiscoveredTrack(
        "iracing",
        identity.trackId,
        identity.trackName,
      ),
    );
  }
  await Promise.all(writes);

  const [carName, trackName] = await Promise.all([
    identity.carId >= 0
      ? getDiscoveredCarName("iracing", identity.carId)
      : undefined,
    identity.trackId >= 0
      ? getDiscoveredTrackName("iracing", identity.trackId)
      : undefined,
  ]);
  rememberIRacingIdentity({
    carId: identity.carId,
    carName: carName ?? identity.carName,
    trackId: identity.trackId,
    trackName: trackName ?? identity.trackName,
  });
}

/**
 * Accept identity from the live SDK source. Parsers and passive replay remain
 * pure so merely reading a historical capture cannot mutate the registry.
 */
export async function registerLiveIRacingIdentity(
  session: IRacingSessionSnapshot,
): Promise<void> {
  await registerAcceptedIRacingIdentity(session);
}

/**
 * Accept identity when the user explicitly commits a validated IBT import.
 * Preview and cancel remain read-only.
 */
export async function registerImportedIRacingIdentity(
  identity: Pick<
    IRacingSessionSnapshot,
    "carId" | "carName" | "trackId" | "trackName"
  >,
): Promise<void> {
  await registerAcceptedIRacingIdentity(identity);
}
