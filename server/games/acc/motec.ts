import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "../../motec/kunos-packets";
import { prepareKunosMotecCapture, MOTEC_IMPORT_LIMITATIONS } from "../../motec/kunos-synthesis";
import type { LdLog } from "../../motec/ld";
import type { MotecCarTrack, MotecCarTrackOverride, MotecConversionResult } from "../../motec/types";

export function resolveAccMotecCarTrack(log: LdLog, override?: MotecCarTrackOverride): MotecCarTrack {
  return { carId: override?.carId ?? log.vehicleId, trackId: override?.trackId ?? log.venue, carModel: log.vehicleId, trackName: log.venue };
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
} satisfies KunosMotecPacketProfile;
export function convertAccMotecToPackets(log: LdLog, beacons: number[], carTrack: MotecCarTrack): MotecConversionResult {
  const prepared = prepareKunosMotecCapture(log, beacons, { gameId: "acc" });
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
