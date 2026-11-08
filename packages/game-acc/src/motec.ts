import { getAccCarByModel, getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName, getAccTrackBySetupFolder, getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "@raceiq/backend-core/motec/kunos-packets";
import { prepareKunosMotecCapture, MOTEC_IMPORT_LIMITATIONS } from "@raceiq/backend-core/motec/kunos-synthesis";
import type { LdLog } from "@raceiq/backend-core/motec/ld";
import type { MotecCarTrack, MotecCarTrackOverride, MotecConversionResult } from "@raceiq/backend-core/motec/types";
import type { MotecTarget } from "@raceiq/backend-core/motec/targets";
import { getGame } from "@raceiq/shared/games/registry";

export function resolveAccMotecCarTrack(log: LdLog, override?: MotecCarTrackOverride): MotecCarTrack {
  const car = getAccCarByModel(log.vehicleId);
  const track = log.venue ? getAccTrackBySetupFolder(log.venue) ?? getAccTrackByName(log.venue) : undefined;
  const carId = override?.carId ?? log.vehicleId;
  const trackId = override?.trackId ?? log.venue;
  return {
    carId,
    trackId,
    carModel: override?.carName ?? (override?.carId && /^\d+$/.test(override.carId) ? getAccCarName(Number(override.carId)) : override?.carId ?? car?.name ?? log.vehicleId),
    trackName: override?.trackName ?? (override?.trackId
      ? (/^\d+$/.test(override.trackId) ? getAccTracks().get(Number(override.trackId))?.name ?? override.trackId : override.trackId)
      : track?.name ?? log.venue),
  };
}
export { MOTEC_IMPORT_LIMITATIONS };
const ACC_MOTEC_PACKET_PROFILE = {
  gameId: "acc",
  drivetrainType: 0,
  currentRaceTime: "session",
  tireCompound: "",
  detailedTireTemperatures: false,
  brakePadWear: 0,
  currentSectorIndex: 0,
  trackGripStatus: "",
  includeUnknownCarModel: false,
} satisfies KunosMotecPacketProfile;
export function convertAccMotecToPackets(log: LdLog, beacons: number[], carTrack: MotecCarTrack): MotecConversionResult {
  const track = carTrack.trackId && !/^\d+$/.test(carTrack.trackId)
    ? getAccTrackBySetupFolder(carTrack.trackId) ?? getAccTrackByName(carTrack.trackId)
    : undefined;
  const prepared = prepareKunosMotecCapture(log, beacons, {
    gameId: "acc",
    trackId: track ? String(track.id) : carTrack.trackId,
  });
  const packets = convertPreparedKunosMotecPackets(
    prepared,
    carTrack,
    ACC_MOTEC_PACKET_PROFILE,
  );
  return {
    packets,
    frameCount: prepared.frameCount,
    lapCount: prepared.windows.length,
    carTrack,
    missingChannels: prepared.missingChannels,
    sampleRates: log.channels.map((channel) => ({
      name: channel.name,
      hz: channel.effectiveFreq,
    })),
    yawFromLateralG: prepared.path.yawFromLateralG,
  };
}

export function createAccMotecTarget(): MotecTarget {
  const acc = getGame("acc");
  return {
    gameId: "acc",
    displayName: acc.displayName,
    routePrefix: acc.routePrefix,
    carsEndpoint: "/api/acc/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    convert: convertAccMotecToPackets,
    resolveCarTrack: resolveAccMotecCarTrack,
  };
}
