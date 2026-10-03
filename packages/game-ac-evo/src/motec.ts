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
import { getAcEvoCarByModel, getAcEvoCarName } from "@raceiq/shared/racing/cars/ac-evo";
import {
  getAcEvoTrackByName,
  getAcEvoTrackBySetupFolder,
  getAcEvoTracks,
} from "@raceiq/shared/racing/tracks/catalogs/ac-evo";

export function resolveAcEvoMotecCarTrack(
  log: LdLog,
  override?: MotecCarTrackOverride,
): MotecCarTrack {
  const car =
    override?.carOrdinal !== undefined && override.carOrdinal >= 0
      ? { id: override.carOrdinal, name: getAcEvoCarName(override.carOrdinal) }
      : getAcEvoCarByModel(log.vehicleId);
  const track =
    override?.trackOrdinal !== undefined && override.trackOrdinal >= 0
      ? getAcEvoTracks().get(override.trackOrdinal)
      : getAcEvoTrackBySetupFolder(log.venue) ?? getAcEvoTrackByName(log.venue);
  return {
    carOrdinal: car?.id ?? -1,
    trackOrdinal: track?.id ?? -1,
    carModel: car?.name ?? log.vehicleId,
    trackName: track?.commonTrackName ?? log.venue,
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
    trackOrdinal: carTrack.trackOrdinal,
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
