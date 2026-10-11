import { getAccCarByModel, getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName, getAccTrackBySetupFolder } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "@raceiq/backend-core/motec/kunos-packets";
import { prepareKunosMotecCapture, MOTEC_IMPORT_LIMITATIONS } from "@raceiq/backend-core/motec/kunos-synthesis";
import type { LdLog } from "@raceiq/backend-core/motec/ld";
import type { MotecCarTrack, MotecCarTrackOverride, MotecConversionResult } from "@raceiq/backend-core/motec/types";

export function resolveAccMotecCarTrack(log: LdLog, override?: MotecCarTrackOverride): MotecCarTrack {
  const car = getAccCarByModel(log.vehicleId);
  const track = getAccTrackBySetupFolder(log.venue) ?? getAccTrackByName(log.venue);
  const carId = override?.carId ?? String(car?.id ?? "");
  const trackId = override?.trackId ?? String(track?.id ?? "");
  return {
    carId,
    trackId,
    carModel: override?.carName ?? (carId ? getAccCarName(Number(carId)) : log.vehicleId),
    trackName: override?.trackName ?? track?.name ?? log.venue,
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
  const prepared = prepareKunosMotecCapture(log, beacons, {
    gameId: "acc",
    trackId: carTrack.trackId,
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
