import { getAccCarByModel, getAccCarName } from "../../../shared/racing/cars/acc";
import { getAccTrackByName, getAccTrackBySetupFolder, getAccTracks } from "../../../shared/racing/tracks/catalogs/acc";
import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "../../motec/kunos-packets";
import { prepareKunosMotecCapture, MOTEC_IMPORT_LIMITATIONS } from "../../motec/kunos-synthesis";
import type { LdLog } from "../../motec/ld";
import type { MotecCarTrack, MotecCarTrackOverride, MotecConversionResult } from "../../motec/types";

export function resolveAccMotecCarTrack(log: LdLog, override?: MotecCarTrackOverride): MotecCarTrack {
  const car = override?.carOrdinal !== undefined && override.carOrdinal >= 0 ? { id: override.carOrdinal, name: getAccCarName(override.carOrdinal) } : getAccCarByModel(log.vehicleId);
  const track = override?.trackOrdinal !== undefined && override.trackOrdinal >= 0 ? getAccTracks().get(override.trackOrdinal) : getAccTrackBySetupFolder(log.venue) ?? getAccTrackByName(log.venue);
  return { carOrdinal: car?.id ?? -1, trackOrdinal: track?.id ?? -1, carModel: car?.name ?? log.vehicleId, trackName: track?.name ?? log.venue };
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
    trackOrdinal: carTrack.trackOrdinal,
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
