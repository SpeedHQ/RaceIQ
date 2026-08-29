import { AC_STATUS, GRAPHICS, PHYSICS, STATIC } from "./structs";
import { ACC_PACKED_MAGIC, packTriplet } from "../kunos/pack-triplet";
import { encodeFrameLength, encodeMetaFrame } from "../../session-capture/framing";
import { getAccCarByModel, getAccCarName } from "../../../shared/racing/cars/acc";
import { getAccTrackByName, getAccTrackBySetupFolder, getAccTracks } from "../../../shared/racing/tracks/catalogs/acc";
import { prepareKunosMotecCapture, MOTEC_IMPORT_LIMITATIONS } from "../../motec/kunos-synthesis";
import { type LdLog } from "../../motec/ld";
import type { MotecCarTrack, MotecCarTrackOverride, SynthesizeResult } from "../../motec/types";

function writeWString(buf: Buffer, offset: number, size: number, value: string): void {
  buf.fill(0, offset, offset + size);
  buf.write(value.slice(0, Math.floor(size / 2) - 1), offset, "utf16le");
}

export function resolveAccMotecCarTrack(log: LdLog, override?: MotecCarTrackOverride): MotecCarTrack {
  const car = override?.carOrdinal !== undefined && override.carOrdinal >= 0
    ? { id: override.carOrdinal, name: getAccCarName(override.carOrdinal) }
    : getAccCarByModel(log.vehicleId);
  const track = override?.trackOrdinal !== undefined && override.trackOrdinal >= 0
    ? getAccTracks().get(override.trackOrdinal)
    : getAccTrackBySetupFolder(log.venue) ?? getAccTrackByName(log.venue);
  return {
    carOrdinal: car?.id ?? -1,
    trackOrdinal: track?.id ?? -1,
    carModel: car?.name ?? log.vehicleId,
    trackName: track?.name ?? log.venue,
  };
}

export { MOTEC_IMPORT_LIMITATIONS };

export function synthesizeAccCapture(log: LdLog, beacons: number[], override?: MotecCarTrackOverride): SynthesizeResult {
  const prepared = prepareKunosMotecCapture(log, beacons);
  const carTrack = resolveAccMotecCarTrack(log, override);
  const staticBuf = Buffer.alloc(STATIC.SIZE);
  writeWString(staticBuf, STATIC.carModel.offset, STATIC.carModel.size, carTrack.carModel);
  writeWString(staticBuf, STATIC.track.offset, STATIC.track.size, carTrack.trackName);
  writeWString(staticBuf, STATIC.playerName.offset, STATIC.playerName.size, log.driver);
  staticBuf.writeInt32LE(1, STATIC.numberOfSessions.offset);
  staticBuf.writeInt32LE(1, STATIC.numCars.offset);
  staticBuf.writeFloatLE(prepared.lapLengthM, STATIC.trackSplineLength.offset);

  const records: Buffer[] = [];
  let bestMs = 0;
  for (let i = 0; i < prepared.frameCount; i++) {
    const lap = prepared.lapIndexOf[i]!;
    const [lapStart] = prepared.windows[lap]!;
    const currentMs = Math.round((i * prepared.dt - lapStart) * 1000);
    const previous = lap > 0 ? prepared.windows[lap - 1]! : undefined;
    const lastMs = previous ? Math.round((previous[1] - previous[0]) * 1000) : 0;
    if (lastMs > 0 && (bestMs === 0 || lastMs < bestMs)) bestMs = lastMs;

    const physics = Buffer.alloc(PHYSICS.SIZE);
    physics.writeInt32LE(i, PHYSICS.packetId.offset);
    physics.writeFloatLE(prepared.throttle[i]!, PHYSICS.gas.offset);
    physics.writeFloatLE(prepared.brake[i]!, PHYSICS.brake.offset);
    physics.writeFloatLE(prepared.fuel[i]!, PHYSICS.fuel.offset);
    physics.writeInt32LE(Math.max(0, Math.round(prepared.gear[i]!) + 1), PHYSICS.gear.offset);
    physics.writeInt32LE(Math.round(prepared.rpm[i]!), PHYSICS.rpms.offset);
    physics.writeFloatLE(Math.max(-1, Math.min(1, prepared.steerDegrees[i]! / 240)), PHYSICS.steerAngle.offset);
    physics.writeFloatLE(prepared.speedKmh[i]!, PHYSICS.speedKmh.offset);
    physics.writeFloatLE(prepared.path.vx[i]!, PHYSICS.velocityX.offset);
    physics.writeFloatLE(prepared.path.vz[i]!, PHYSICS.velocityZ.offset);
    physics.writeFloatLE(prepared.lateralG[i]!, PHYSICS.accGX.offset);
    physics.writeFloatLE(prepared.longitudinalG[i]!, PHYSICS.accGZ.offset);
    physics.writeFloatLE(prepared.yawRate[i]!, PHYSICS.localAngularVelY.offset);
    physics.writeFloatLE(prepared.tc[i]!, PHYSICS.tc.offset);
    physics.writeFloatLE(prepared.abs[i]!, PHYSICS.abs.offset);
    physics.writeFloatLE(prepared.clutch[i]!, PHYSICS.clutch.offset);
    physics.writeFloatLE(Number.NaN, PHYSICS.brakeBias.offset);
    for (const field of [
      PHYSICS.wheelSlipFL, PHYSICS.wheelSlipFR, PHYSICS.wheelSlipRL, PHYSICS.wheelSlipRR,
      PHYSICS.slipRatioFL, PHYSICS.slipRatioFR, PHYSICS.slipRatioRL, PHYSICS.slipRatioRR,
      PHYSICS.slipAngleFL, PHYSICS.slipAngleFR, PHYSICS.slipAngleRL, PHYSICS.slipAngleRR,
    ]) {
      physics.writeFloatLE(Number.NaN, field.offset);
    }
    for (let c = 0; c < 4; c++) {
      const wheel = ["FL", "FR", "RL", "RR"][c]!;
      const p = PHYSICS[`tyrePressure${wheel}` as keyof typeof PHYSICS] as { offset: number };
      const core = PHYSICS[`tyreCore${wheel}` as keyof typeof PHYSICS] as { offset: number };
      const temp = PHYSICS[`tyreTemp${wheel}` as keyof typeof PHYSICS] as { offset: number };
      const brake = PHYSICS[`brakeTemp${wheel}` as keyof typeof PHYSICS] as { offset: number };
      const susp = PHYSICS[`suspTravel${wheel}` as keyof typeof PHYSICS] as { offset: number };
      const rot = PHYSICS[`wheelRot${wheel}` as keyof typeof PHYSICS] as { offset: number };
      physics.writeFloatLE(prepared.tyrePressure[c]![i]!, p.offset);
      physics.writeFloatLE(prepared.tyreTemperature[c]![i]!, core.offset);
      physics.writeFloatLE(prepared.tyreTemperature[c]![i]!, temp.offset);
      physics.writeFloatLE(prepared.brakeTemperature[c]![i]!, brake.offset);
      const travel = prepared.suspensionTravelUnits.toLowerCase().includes("mm") ? prepared.suspensionTravel[c]![i]! / 1000 : prepared.suspensionTravel[c]![i]!;
      physics.writeFloatLE(travel, susp.offset);
      physics.writeFloatLE(prepared.wheelSpeed[c]![i]!, rot.offset);
    }

    const graphics = Buffer.alloc(GRAPHICS.SIZE);
    graphics.writeInt32LE(i, GRAPHICS.packetId.offset);
    graphics.writeInt32LE(AC_STATUS.AC_LIVE, GRAPHICS.status.offset);
    graphics.writeInt32LE(lap, GRAPHICS.completedLaps.offset);
    graphics.writeInt32LE(1, GRAPHICS.position.offset);
    graphics.writeInt32LE(currentMs, GRAPHICS.iCurrentTime.offset);
    graphics.writeInt32LE(lastMs, GRAPHICS.iLastTime.offset);
    graphics.writeInt32LE(bestMs, GRAPHICS.iBestTime.offset);
    graphics.writeFloatLE(prepared.sessionDistanceM[i]!, GRAPHICS.distanceTraveled.offset);
    graphics.writeInt32LE(0, GRAPHICS.isInPit.offset);
    graphics.writeFloatLE(prepared.lapLengthM > 0 ? Math.min(1, prepared.lapDistanceM[i]! / prepared.lapLengthM) : 0, GRAPHICS.normalizedCarPosition.offset);
    graphics.writeInt32LE(1, GRAPHICS.activeCars.offset);
    graphics.writeFloatLE(prepared.path.x[i]!, GRAPHICS.carCoordinatesBase.offset);
    graphics.writeFloatLE(0, GRAPHICS.carCoordinatesBase.offset + 4);
    graphics.writeFloatLE(prepared.path.z[i]!, GRAPHICS.carCoordinatesBase.offset + 8);
    graphics.writeInt32LE(1, GRAPHICS.carIDBase.offset);
    graphics.writeInt32LE(1, GRAPHICS.playerCarID.offset);
    graphics.writeInt32LE(0, GRAPHICS.isInPitLane.offset);
    graphics.writeInt32LE(0, GRAPHICS.flag.offset);
    graphics.writeInt32LE(0, GRAPHICS.tcGraphics.offset);
    graphics.writeInt32LE(0, GRAPHICS.tcCut.offset);
    graphics.writeInt32LE(0, GRAPHICS.engineMap.offset);
    graphics.writeInt32LE(0, GRAPHICS.absGraphics.offset);
    graphics.writeInt32LE(0, GRAPHICS.rainTyres.offset);
    graphics.writeInt32LE(1, GRAPHICS.isValidLap.offset);
    records.push(packTriplet(ACC_PACKED_MAGIC, carTrack.carOrdinal, carTrack.trackOrdinal, physics, graphics, staticBuf));
  }
  const parts: Buffer[] = [encodeMetaFrame(records.length)];
  for (const record of records) parts.push(encodeFrameLength(record.length), record);
  return { bin: Buffer.concat(parts), frameCount: records.length, lapCount: prepared.windows.length, carTrack, missingChannels: prepared.missingChannels, sampleRates: log.channels.map((channel) => ({ name: channel.name, hz: channel.effectiveFreq })), yawFromLateralG: prepared.path.yawFromLateralG };
}
