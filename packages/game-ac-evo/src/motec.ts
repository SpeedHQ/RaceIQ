import type { LdLog } from "@raceiq/backend-core/motec/ld";
import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "@raceiq/backend-core/motec/kunos-packets";
import { prepareKunosMotecCapture } from "@raceiq/backend-core/motec/kunos-synthesis";
import type {
  MotecCarTrack,
  MotecCarTrackOverride,
  MotecConversionResult,
} from "@raceiq/backend-core/motec/types";
import { getAcEvoCarByModel, getAcEvoCarByDisplayName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTrackByName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { acEvoCarId, acEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";

export function resolveAcEvoMotecCarTrack(
  log: LdLog,
  override?: MotecCarTrackOverride,
): MotecCarTrack {
  const carName = override?.carName?.trim() || (typeof override?.carId === "string" ? override.carId.trim() : "") || log.vehicleId.trim();
  const nativeCar = getAcEvoCarByDisplayName(carName) ?? getAcEvoCarByModel(carName);
  const trackName = override?.trackName?.trim() || log.venue.trim();
  const trackConfiguration = override?.trackConfiguration?.trim() ?? "";
  const nativeTrack = getAcEvoTrackByName(trackName, trackConfiguration);
  const carModel = nativeCar?.name ?? carName;
  return {
    carId: override?.carId ?? acEvoCarId(carModel),
    trackId: override?.trackId ?? nativeTrack?.id ?? acEvoTrackId(trackName, trackConfiguration),
    carModel,
    trackName,
  };
}

const AC_EVO_MOTEC_PACKET_PROFILE = {
  gameId: "ac-evo",
  drivetrainType: 1,
  currentRaceTime: "lap",
  tireCompound: "dry_compound",
  detailedTireTemperatures: true,
  brakePadWear: -1,
  currentSectorIndex: -1,
  trackGripStatus: "unknown",
  includeUnknownCarModel: true,
} satisfies KunosMotecPacketProfile;

export function convertAcEvoMotecToPackets(
  log: LdLog,
  beacons: number[],
  carTrack: MotecCarTrack,
): MotecConversionResult {
  const prepared = prepareKunosMotecCapture(log, beacons, {
    gameId: "ac-evo",
    trackId: carTrack.trackId,
  });
  const packets = convertPreparedKunosMotecPackets(
    prepared,
    carTrack,
    AC_EVO_MOTEC_PACKET_PROFILE,
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
