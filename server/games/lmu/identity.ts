import { rememberLMUIdentity } from "../../../shared/games/lmu";
import {
  getDiscoveredCarName,
  registerDiscoveredCar,
} from "../../db/discovered-cars";
import {
  getDiscoveredTrackName,
  registerDiscoveredTrack,
} from "../../db/discovered-tracks";
import type { LMUIdentity } from "./source-frame";

async function registerAcceptedLMUIdentity(
  identity: LMUIdentity,
): Promise<void> {
  await Promise.all([
    registerDiscoveredCar("lmu", identity.carId, identity.carName),
    registerDiscoveredTrack("lmu", identity.trackId, identity.trackName),
  ]);
  const [carName, trackName] = await Promise.all([
    getDiscoveredCarName("lmu", identity.carId),
    getDiscoveredTrackName("lmu", identity.trackId),
  ]);
  rememberLMUIdentity({
    carId: identity.carId,
    carName: carName ?? identity.carName,
    trackId: identity.trackId,
    trackName: trackName ?? identity.trackName,
  });
}

export async function registerLiveLMUIdentity(
  identity: LMUIdentity,
): Promise<void> {
  await registerAcceptedLMUIdentity(identity);
}

export async function registerImportedLMUIdentity(
  identity: LMUIdentity,
): Promise<void> {
  await registerAcceptedLMUIdentity(identity);
}
