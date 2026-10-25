import { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE } from "@raceiq/capture-formats/lmu/layout";

export function playerMemory(): Buffer {
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  memory.writeInt32LE(42, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
  memory.writeDoubleLE(10, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
  memory.writeDoubleLE(8000, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineRpm);
  memory.writeDoubleLE(430, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineTorque);
  memory.writeDoubleLE(95, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineWaterTemp);
  memory.writeDoubleLE(64, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorTemperature);
  memory.writeDoubleLE(57, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorTorque);
  memory.writeUInt8(2, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorState);
  memory.writeDoubleLE(-6.25, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.steeringShaftTorque);
  memory.writeDoubleLE(0.25, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.batteryChargeFraction);
  memory.writeFloatLE(72, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.stateOfCharge);
  memory.writeFloatLE(0.63, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.virtualEnergy);
  memory.writeFloatLE(-80, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.regenKw);
  memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
  memory.writeDoubleLE(10, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
  memory.writeDoubleLE(0.4, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.averagePathWetness);
  memory.writeInt32LE(42, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.id);
  memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
  memory.writeInt16LE(2, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.penaltyCount);
  return memory;
}
