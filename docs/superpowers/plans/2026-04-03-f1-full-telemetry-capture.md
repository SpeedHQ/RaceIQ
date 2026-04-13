# F1 Full Telemetry Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture ALL F1 2025 UDP telemetry data so nothing from the game is lost.

**Architecture:** Add MotionEx (packet 13) parser to fill real suspension/wheel/force data into existing TelemetryPacket fields (replacing zeros/estimates). Expand F1ExtendedData with new sub-objects for all remaining data. Store additional per-packet fields in the CSV telemetry format.

**Tech Stack:** TypeScript, Bun, binary packet parsing, gzipped CSV storage

---

## Priority Order

1. **MotionEx (packet 13)** — fills TelemetryPacket fields currently set to 0 (suspension, wheel speeds, slip, forces)
2. **CarStatus extended fields** — engine power ICE/MGUK, fuel remaining laps, traction control, ABS
3. **CarDamage extended fields** — tyre/brake damage, engine component wear
4. **CarTelemetry extended fields** — inner tyre temps, engine temp, clutch, surface type
5. **LapData extended fields** — penalties, warnings, pit lane timing, speed trap
6. **Session extended fields** — safety car, weather forecast, sector distances, assists

Events (packet 3), TyreSets (12), TimeTrial (14), LapPositions (15) are session-level data that don't belong in per-packet telemetry — they can be tracked separately in a future task.

---

### Task 1: Parse MotionEx packet (ID 13) — fill real physics data

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Add motionEx state to accumulator**

In `f1-state.ts`, add after the `carSetup` state field:

```typescript
private motionEx: {
  suspensionPositionRL: number; suspensionPositionRR: number;
  suspensionPositionFL: number; suspensionPositionFR: number;
  suspensionVelocityRL: number; suspensionVelocityRR: number;
  suspensionVelocityFL: number; suspensionVelocityFR: number;
  wheelSpeedRL: number; wheelSpeedRR: number;
  wheelSpeedFL: number; wheelSpeedFR: number;
  wheelSlipRatioRL: number; wheelSlipRatioRR: number;
  wheelSlipRatioFL: number; wheelSlipRatioFR: number;
  wheelSlipAngleRL: number; wheelSlipAngleRR: number;
  wheelSlipAngleFL: number; wheelSlipAngleFR: number;
  wheelLatForceRL: number; wheelLatForceRR: number;
  wheelLatForceFL: number; wheelLatForceFR: number;
  wheelLongForceRL: number; wheelLongForceRR: number;
  wheelLongForceFL: number; wheelLongForceFR: number;
  wheelVertForceRL: number; wheelVertForceRR: number;
  wheelVertForceFL: number; wheelVertForceFR: number;
  heightOfCOGAboveGround: number;
  localVelocityX: number; localVelocityY: number; localVelocityZ: number;
  angularVelocityX: number; angularVelocityY: number; angularVelocityZ: number;
  angularAccelerationX: number; angularAccelerationY: number; angularAccelerationZ: number;
  frontWheelsAngle: number;
  frontAeroHeight: number; rearAeroHeight: number;
  frontRollAngle: number; rearRollAngle: number;
  chassisYaw: number; chassisPitch: number;
} | null = null;
```

Add `this.motionEx = null;` to `reset()`.
Add `case 13: this.parseMotionEx(data); break;` to the switch.

- [ ] **Step 2: Implement parseMotionEx**

MotionEx is player-car only (not per-car array). All floats, sequential:

```typescript
private parseMotionEx(data: Buffer): void {
  // MotionEx: all floats, player car only (no per-car array)
  // Order: suspPos[4], suspVel[4], suspAccel[4], wheelSpeed[4],
  // wheelSlipRatio[4], wheelSlipAngle[4], wheelLatForce[4], wheelLongForce[4],
  // heightCOG, localVel[3], angVel[3], angAccel[3], frontWheelsAngle,
  // wheelVertForce[4], frontAeroH, rearAeroH, frontRollAngle, rearRollAngle,
  // chassisYaw, chassisPitch, wheelCamber[4], wheelCamberGain[4]
  // All arrays are RL, RR, FL, FR order
  if (data.length < 220) return; // approximate minimum size
  let o = 0;
  const f = () => { const v = data.readFloatLE(o); o += 4; return v; };

  this.motionEx = {
    suspensionPositionRL: f(), suspensionPositionRR: f(),
    suspensionPositionFL: f(), suspensionPositionFR: f(),
    suspensionVelocityRL: f(), suspensionVelocityRR: f(),
    suspensionVelocityFL: f(), suspensionVelocityFR: f(),
    // skip suspensionAcceleration[4]
    ...(o += 16, {}),
    wheelSpeedRL: f(), wheelSpeedRR: f(),
    wheelSpeedFL: f(), wheelSpeedFR: f(),
    wheelSlipRatioRL: f(), wheelSlipRatioRR: f(),
    wheelSlipRatioFL: f(), wheelSlipRatioFR: f(),
    wheelSlipAngleRL: f(), wheelSlipAngleRR: f(),
    wheelSlipAngleFL: f(), wheelSlipAngleFR: f(),
    wheelLatForceRL: f(), wheelLatForceRR: f(),
    wheelLatForceFL: f(), wheelLatForceFR: f(),
    wheelLongForceRL: f(), wheelLongForceRR: f(),
    wheelLongForceFL: f(), wheelLongForceFR: f(),
    heightOfCOGAboveGround: f(),
    localVelocityX: f(), localVelocityY: f(), localVelocityZ: f(),
    angularVelocityX: f(), angularVelocityY: f(), angularVelocityZ: f(),
    angularAccelerationX: f(), angularAccelerationY: f(), angularAccelerationZ: f(),
    frontWheelsAngle: f(),
    wheelVertForceRL: f(), wheelVertForceRR: f(),
    wheelVertForceFL: f(), wheelVertForceFR: f(),
    frontAeroHeight: f(), rearAeroHeight: f(),
    frontRollAngle: f(), rearRollAngle: f(),
    chassisYaw: f(), chassisPitch: f(),
    // skip wheelCamber[4] and wheelCamberGain[4] — not mapped to TelemetryPacket
  };
}
```

- [ ] **Step 3: Map MotionEx into TelemetryPacket fields in buildPacket**

Replace the zero'd fields with real data when motionEx is available:

```typescript
const mx = this.motionEx;

// Suspension (normalize to 0-1 range based on typical F1 travel ~30mm)
NormSuspensionTravelFL: mx ? Math.max(0, Math.min(1, (mx.suspensionPositionFL + 0.015) / 0.03)) : 0,
NormSuspensionTravelFR: mx ? Math.max(0, Math.min(1, (mx.suspensionPositionFR + 0.015) / 0.03)) : 0,
NormSuspensionTravelRL: mx ? Math.max(0, Math.min(1, (mx.suspensionPositionRL + 0.015) / 0.03)) : 0,
NormSuspensionTravelRR: mx ? Math.max(0, Math.min(1, (mx.suspensionPositionRR + 0.015) / 0.03)) : 0,

SuspensionTravelMetersFL: mx?.suspensionPositionFL ?? 0,
SuspensionTravelMetersFR: mx?.suspensionPositionFR ?? 0,
SuspensionTravelMetersRL: mx?.suspensionPositionRL ?? 0,
SuspensionTravelMetersRR: mx?.suspensionPositionRR ?? 0,

// Wheel rotation speed (rad/s) — MotionEx wheelSpeed is m/s, convert via tire radius
WheelRotationSpeedFL: mx ? mx.wheelSpeedFL / 0.36 : speed / 0.36,
WheelRotationSpeedFR: mx ? mx.wheelSpeedFR / 0.36 : speed / 0.36,
WheelRotationSpeedRL: mx ? mx.wheelSpeedRL / 0.36 : speed / 0.36,
WheelRotationSpeedRR: mx ? mx.wheelSpeedRR / 0.36 : speed / 0.36,

// Slip ratios
TireSlipRatioFL: mx?.wheelSlipRatioFL ?? 0,
TireSlipRatioFR: mx?.wheelSlipRatioFR ?? 0,
TireSlipRatioRL: mx?.wheelSlipRatioRL ?? 0,
TireSlipRatioRR: mx?.wheelSlipRatioRR ?? 0,

// Slip angles → combined slip (magnitude)
TireCombinedSlipFL: mx ? Math.sqrt(mx.wheelSlipRatioFL ** 2 + mx.wheelSlipAngleFL ** 2) : 0,
// ... same for FR, RL, RR

// Angular velocity
AngularVelocityX: mx?.angularVelocityX ?? 0,
AngularVelocityY: mx?.angularVelocityY ?? 0,
AngularVelocityZ: mx?.angularVelocityZ ?? 0,
```

- [ ] **Step 4: Add MotionEx fields to F1ExtendedData**

In `shared/types.ts`, add to F1ExtendedData:

```typescript
// MotionEx — per-packet detailed physics
motionEx?: {
  wheelSlipAngleFL: number; wheelSlipAngleFR: number;
  wheelSlipAngleRL: number; wheelSlipAngleRR: number;
  wheelLatForceFL: number; wheelLatForceFR: number;
  wheelLatForceRL: number; wheelLatForceRR: number;
  wheelLongForceFL: number; wheelLongForceFR: number;
  wheelLongForceRL: number; wheelLongForceRR: number;
  wheelVertForceFL: number; wheelVertForceFR: number;
  wheelVertForceRL: number; wheelVertForceRR: number;
  frontWheelsAngle: number;
  frontAeroHeight: number; rearAeroHeight: number;
  frontRollAngle: number; rearRollAngle: number;
  chassisYaw: number; chassisPitch: number;
  heightOfCOGAboveGround: number;
};
```

- [ ] **Step 5: Run tests and build**

```bash
bun test && cd client && bun run build
```

- [ ] **Step 6: Commit**

```bash
git add server/parsers/f1-state.ts shared/types.ts
git commit -m "feat: parse MotionEx packet — real suspension, slip, forces for F1"
```

---

### Task 2: Capture extended CarStatus fields

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Expand carStatus accumulator state**

Add missing fields to the `carStatus` state: `tractionControl`, `antiLockBrakes`, `fuelMix`, `frontBrakeBias`, `pitLimiterStatus`, `fuelRemainingLaps`, `drsActivationDistance`, `enginePowerICE`, `enginePowerMGUK`, `vehicleFIAFlags`.

- [ ] **Step 2: Parse the fields in parseCarStatus**

Read the additional bytes from the CarStatusData struct.

- [ ] **Step 3: Add to F1ExtendedData and buildPacket**

Add `tractionControl`, `antiLockBrakes`, `fuelMix`, `frontBrakeBias`, `enginePowerICE`, `enginePowerMGUK`, `fuelRemainingLaps` to the f1 object.

- [ ] **Step 4: Build, test, commit**

---

### Task 3: Capture extended CarDamage fields

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Expand carDamage accumulator state**

Add: `tyresDamage[4]`, `brakesDamage[4]`, `tyreBlisters[4]`, `drsFault`, `ersFault`, `gearBoxDamage`, `engineDamage`, `engineMGUHWear`, `engineESWear`, `engineCEWear`, `engineICEWear`, `engineMGUKWear`, `engineTCWear`.

- [ ] **Step 2: Parse and map into F1ExtendedData**

- [ ] **Step 3: Build, test, commit**

---

### Task 4: Capture extended CarTelemetry fields

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Add to accumulator**

Add: `clutch`, `tyresInnerTemp[4]`, `engineTemperature`, `surfaceType[4]`, `suggestedGear`.

- [ ] **Step 2: Parse and map**

Map `clutch` to `TelemetryPacket.Clutch`. Add inner temps and engine temp to F1ExtendedData.

- [ ] **Step 3: Build, test, commit**

---

### Task 5: Capture extended LapData fields

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Add to accumulator**

Add player-car fields: `currentLapInvalid`, `penalties`, `totalWarnings`, `cornerCuttingWarnings`, `driverStatus`, `pitLaneTimerActive`, `pitLaneTimeInLaneInMS`, `speedTrapFastestSpeed`, `gridPosition`.

- [ ] **Step 2: Parse and map into F1ExtendedData**

- [ ] **Step 3: Build, test, commit**

---

### Task 6: Capture extended Session fields

**Files:**
- Modify: `server/parsers/f1-state.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Expand session state**

Add: `safetyCarStatus`, `trackLength`, `pitSpeedLimit`, `forecastAccuracy`, `aiDifficulty`, `sector2LapDistanceStart`, `sector3LapDistanceStart`, `pitStopWindowIdealLap`, `pitStopWindowLatestLap`, `formula`, weather forecast array (first 5 samples).

- [ ] **Step 2: Parse and map into F1ExtendedData**

- [ ] **Step 3: Build, test, commit**

---

### Task 7: Ensure new fields survive telemetry CSV storage

**Files:**
- Modify: `server/db/queries.ts` (TELEMETRY_FIELDS array)

The CSV telemetry format stores fields listed in `TELEMETRY_FIELDS`. Any new F1ExtendedData fields stored on the `f1` sub-object are preserved via the JSON meta line, BUT fields mapped to top-level TelemetryPacket (like suspension, slip ratios from MotionEx) need to be in the CSV fields list.

- [ ] **Step 1: Verify TELEMETRY_FIELDS includes all mapped fields**

Check that `NormSuspensionTravelFL`, `SuspensionTravelMetersFL`, `TireSlipRatioFL`, `TireCombinedSlipFL`, `AngularVelocityX` etc. are in the fields list.

- [ ] **Step 2: Add any missing fields**

- [ ] **Step 3: Build, test, commit**
