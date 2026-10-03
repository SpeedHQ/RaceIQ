import type { LdLog } from "@raceiq/backend-core/motec/ld";
import {
  convertPreparedKunosMotecPackets,
  type KunosMotecPacketProfile,
} from "@raceiq/backend-core/motec/kunos-packets";
import { prepareKunosMotecCapture } from "@raceiq/backend-core/motec/kunos-synthesis";
import type { MotecCarTrack, MotecConversionResult } from "@raceiq/backend-core/motec/types";


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

export function convertAcEvoMotecToPackets(log: LdLog, beacons: number[], carTrack: MotecCarTrack): MotecConversionResult {
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
