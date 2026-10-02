import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import type { LapInsight, OrderedInsight } from "./types";
import { appendInsights, INSIGHT_ORDER, insightAt, insightsAt, midFrame } from "./types";
import { EventRun } from "./types";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";

type TireTemperaturePacketUnit = TelemetryModel["tireTemperature"]["packetUnit"];
type Wheel = "FL" | "FR" | "RL" | "RR";
type TireTemperatureLayer = "primary" | "core";
type TireTemperatureFields = Record<Wheel, keyof TelemetryPacket>;

const WHEELS: readonly Wheel[] = ["FL", "FR", "RL", "RR"];
const PRIMARY_TEMPERATURE_FIELDS: TireTemperatureFields = {
  FL: "TireTempFL",
  FR: "TireTempFR",
  RL: "TireTempRL",
  RR: "TireTempRR",
};
const CORE_TEMPERATURE_FIELDS: TireTemperatureFields = {
  FL: "TireCarcassTempFL",
  FR: "TireCarcassTempFR",
  RL: "TireCarcassTempRL",
  RR: "TireCarcassTempRR",
};


function temperatureValue(packet: TelemetryPacket, field: keyof TelemetryPacket): number | undefined {
  const value = packet[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function temperatureScale(packetUnit: TireTemperaturePacketUnit): { factor: number; unit: string } {
  return packetUnit === "fahrenheit" ? { factor: 1.8, unit: "°F" } : { factor: 1, unit: "°C" };
}

function celsius(value: number, packetUnit: TireTemperaturePacketUnit): number {
  return packetUnit === "fahrenheit" ? (value - 32) / 1.8 : value;
}

function activeTireSample(packet: TelemetryPacket): boolean {
  return Number.isFinite(packet.Speed) && packet.Speed * 2.23694 >= 15 &&
    packet.IsRaceOn !== 0 &&
    (!packet.acc?.pitStatus || packet.acc.pitStatus === "out") &&
    !packet.f1?.pitLimiterStatus && !packet.f1?.pitLaneTimerActive;
}




const SURFACE_PROFILE_FIELDS = {
  FL: ["TireSurfaceTempInnerFL", "TireSurfaceTempMiddleFL", "TireSurfaceTempOuterFL"],
  FR: ["TireSurfaceTempInnerFR", "TireSurfaceTempMiddleFR", "TireSurfaceTempOuterFR"],
  RL: ["TireSurfaceTempInnerRL", "TireSurfaceTempMiddleRL", "TireSurfaceTempOuterRL"],
  RR: ["TireSurfaceTempInnerRR", "TireSurfaceTempMiddleRR", "TireSurfaceTempOuterRR"],
} as const satisfies Record<Wheel, readonly [keyof TelemetryPacket, keyof TelemetryPacket, keyof TelemetryPacket]>;



const PRESSURE_FIELDS = ["TirePressureFrontLeft", "TirePressureFrontRight", "TirePressureRearLeft", "TirePressureRearRight"] as const;
const WEAR_FIELDS = ["TireWearFL", "TireWearFR", "TireWearRL", "TireWearRR"] as const;

interface PressureWindow {
  seconds: number;
  frame: number;
  pressures: number[];
  temperatures: (number | undefined)[];
}
function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}



export function createTireScan(
  telemetry: readonly TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  options: {
    primaryTemperature: boolean;
    primaryTemperatureUnit: TireTemperaturePacketUnit;
    separateCoreTemperature?: { packetUnit: TireTemperaturePacketUnit; identity?: "primary" | "separate-core" };
    primaryTemperatureIdentity?: "primary" | "separate-core";
    surfaceProfile: boolean;
    temperatureSplit?: boolean;
    pressureAnalysis: boolean;
    rapidPressureLoss?: readonly LapInsight[];
  },
): InsightAccumulator {
  const { factor, unit } = temperatureScale(packetUnit);
  const heatRuns = WHEELS.map(() => new EventRun(10 / 60, 0.5));
  const criticalRuns = WHEELS.map(() => new EventRun(10 / 60, 0.5));
  const coreRuns = WHEELS.map(() => new EventRun(10 / 60, 0.5));
  const coreCriticalRuns = WHEELS.map(() => new EventRun(10 / 60, 0.5));
  const heatValues: number[][] = WHEELS.map(() => []);
  const coreValues: number[][] = WHEELS.map(() => []);
  let finalWear: TelemetryPacket | undefined;
  let tempFront = 0, tempRear = 0, tempSeconds = 0, tempEvidence = 0;
  const pressureHistory: PressureWindow[] = [];
  const pressurePending: ({ baseline: PressureWindow; seconds: number; frame: number } | undefined)[] = new Array(4);
  const pressureReported = [false, false, false, false];
  const pressureResults: (LapInsight | undefined)[] = new Array(4);
  let pressureElapsed = 0, pressureWindowSeconds = 0, pressureWindowStart = 0;
  const pressureSums = [0, 0, 0, 0], pressureMin = [Infinity, Infinity, Infinity, Infinity], pressureMax = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pressureTempSums = [0, 0, 0, 0], pressureTempSeconds = [0, 0, 0, 0];
  const pressurePrefix = options.pressureAnalysis ? [0, 1].map(() => ({
    totals: new Float64Array(telemetry.length),
    seconds: new Float64Array(telemetry.length),
    peakIndices: new Uint32Array(telemetry.length),
  })) : undefined;
  const pressureTotals = [0, 0], pressureSeconds = [0, 0], pressurePeaks = [0, 0], pressurePeakIndex = [0, 0];
  let pressureImbalance: LapInsight | null = null;
  const surfaceWindows: { edge: number; shape: number; edgeSign: number; shapeSign: number; frame: number }[][] = WHEELS.map(() => []);
  const surfaceWaiting = [3, 3, 3, 3], surfaceSeconds = [0, 0, 0, 0];
  const surfaceEdge = [0, 0, 0, 0], surfaceShape = [0, 0, 0, 0], surfacePosEdge = [0, 0, 0, 0], surfaceNegEdge = [0, 0, 0, 0], surfacePosShape = [0, 0, 0, 0], surfaceNegShape = [0, 0, 0, 0];
  const surfaceStartTemp = [0, 0, 0, 0], surfaceStart = [0, 0, 0, 0];
  const splitFields = options.separateCoreTemperature ? CORE_TEMPERATURE_FIELDS : PRIMARY_TEMPERATURE_FIELDS;
  const splitUnit = options.separateCoreTemperature?.packetUnit ?? options.primaryTemperatureUnit;
  return {
    observe(index, seconds) {
      const packet = telemetry[index];
      const previous = telemetry[index - 1];
      finalWear = packet;
      const active = seconds > 0 && activeTireSample(packet);
      if (options.temperatureSplit && active && (options.primaryTemperature || options.separateCoreTemperature)) {
        const fl = temperatureValue(packet, splitFields.FL), fr = temperatureValue(packet, splitFields.FR);
        const rl = temperatureValue(packet, splitFields.RL), rr = temperatureValue(packet, splitFields.RR);
        if (fl !== undefined && fr !== undefined && rl !== undefined && rr !== undefined) {
          const front = (celsius(fl, splitUnit) + celsius(fr, splitUnit)) / 2;
          const rear = (celsius(rl, splitUnit) + celsius(rr, splitUnit)) / 2;
          tempFront += front * seconds; tempRear += rear * seconds; tempSeconds += seconds; tempEvidence = index;
        }
      }
      if (pressurePrefix) for (let axle = 0; axle < 2; axle++) {
        if (active) {
          const left = packet[PRESSURE_FIELDS[axle * 2]], right = packet[PRESSURE_FIELDS[axle * 2 + 1]];
          if (left != null && right != null && Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0) {
            const delta = left - right;
            pressureTotals[axle] += delta * seconds; pressureSeconds[axle] += seconds;
            if (Math.abs(delta) > pressurePeaks[axle]) { pressurePeaks[axle] = Math.abs(delta); pressurePeakIndex[axle] = index; }
          }
        }
        pressurePrefix[axle].totals[index] = pressureTotals[axle];
        pressurePrefix[axle].seconds[index] = pressureSeconds[axle];
        pressurePrefix[axle].peakIndices[index] = pressurePeakIndex[axle];
      }
      if (options.surfaceProfile) {
        for (let w = 0; w < 4; w++) {
          const [innerField, middleField, outerField] = SURFACE_PROFILE_FIELDS[WHEELS[w]];
          const innerValue = temperatureValue(packet, innerField), middleValue = temperatureValue(packet, middleField), outerValue = temperatureValue(packet, outerField);
          if (!active || innerValue === undefined || middleValue === undefined || outerValue === undefined) {
            surfaceWaiting[w] = 3;
            surfaceSeconds[w] = surfaceEdge[w] = surfaceShape[w] = surfacePosEdge[w] = surfaceNegEdge[w] = surfacePosShape[w] = surfaceNegShape[w] = 0;
            continue;
          }
          const inner = celsius(innerValue, packetUnit), middle = celsius(middleValue, packetUnit), outer = celsius(outerValue, packetUnit);
          const temp = (inner + middle + outer) / 3, edge = inner - outer, shape = middle - (inner + outer) / 2;
          let available = seconds;
          while (available > 1e-9) {
            if (surfaceWaiting[w] > 1e-9) {
              const skipped = Math.min(surfaceWaiting[w], available);
              surfaceWaiting[w] -= skipped; available -= skipped; continue;
            }
            if (surfaceSeconds[w] === 0) { surfaceStart[w] = index; surfaceStartTemp[w] = temp; }
            const used = Math.min(available, 2 - surfaceSeconds[w]);
            surfaceEdge[w] += edge * used; surfaceShape[w] += shape * used;
            if (edge >= 10) surfacePosEdge[w] += used;
            if (edge <= -10) surfaceNegEdge[w] += used;
            if (shape >= 8) surfacePosShape[w] += used;
            if (shape <= -8) surfaceNegShape[w] += used;
            surfaceSeconds[w] += used; available -= used;
            if (surfaceSeconds[w] < 2 - 1e-9) continue;
            const stable = Math.abs(temp - surfaceStartTemp[w]) <= 2;
            surfaceWindows[w].push({
              edge: surfaceEdge[w] / surfaceSeconds[w], shape: surfaceShape[w] / surfaceSeconds[w],
              edgeSign: stable && surfacePosEdge[w] >= 1.6 ? 1 : stable && surfaceNegEdge[w] >= 1.6 ? -1 : 0,
              shapeSign: stable && surfacePosShape[w] >= 1.6 ? 1 : stable && surfaceNegShape[w] >= 1.6 ? -1 : 0,
              frame: Math.round((surfaceStart[w] + index) / 2),
            });
            surfaceSeconds[w] = surfaceEdge[w] = surfaceShape[w] = surfacePosEdge[w] = surfaceNegEdge[w] = surfacePosShape[w] = surfaceNegShape[w] = 0;
            surfaceWaiting[w] = 1;
          }
        }
      }
      for (let w = 0; w < 4; w++) {
        if (options.primaryTemperature) {
          const value = temperatureValue(packet, PRIMARY_TEMPERATURE_FIELDS[WHEELS[w]]);
          const temp = value === undefined ? undefined : celsius(value, options.primaryTemperatureUnit);
          const hot = active && temp !== undefined && temp > 110;
          heatRuns[w].feed(index, seconds, hot);
          criticalRuns[w].feed(index, seconds, hot && temp > 130);
          heatValues[w][index] = hot ? value! : -Infinity;
        }
        if (options.separateCoreTemperature) {
          const value = temperatureValue(packet, CORE_TEMPERATURE_FIELDS[WHEELS[w]]);
          const temp = value === undefined ? undefined : celsius(value, options.separateCoreTemperature.packetUnit);
          const hot = active && temp !== undefined && temp > 110;
          coreRuns[w].feed(index, seconds, hot);
          coreCriticalRuns[w].feed(index, seconds, hot && temp > 130);
          coreValues[w][index] = hot ? value! : -Infinity;
        }
      }
      if (options.pressureAnalysis && !options.rapidPressureLoss) {
        const changed = previous && (packet.sessionUID !== previous.sessionUID || packet.TyreCompound !== previous.TyreCompound ||
          packet.acc?.tireCompound !== previous.acc?.tireCompound || packet.f1?.actualTyreCompound !== previous.f1?.actualTyreCompound ||
          packet.f1?.tyreCompound !== previous.f1?.tyreCompound ||
          (packet.f1?.tyreAge != null && previous.f1?.tyreAge != null && packet.f1.tyreAge < previous.f1.tyreAge) ||
          WEAR_FIELDS.some((field) => Number.isFinite(packet[field]) && Number.isFinite(previous[field]) && previous[field] - packet[field] > 0.05));
        const valid = active && PRESSURE_FIELDS.every((field) => Number.isFinite(packet[field]) && packet[field]! > 0);
        if (!valid || changed) {
          pressureHistory.length = 0; pressurePending.fill(undefined); pressureReported.fill(false);
          pressureSums.fill(0); pressureMin.fill(Infinity); pressureMax.fill(-Infinity);
          pressureTempSums.fill(0); pressureTempSeconds.fill(0); pressureElapsed = pressureWindowSeconds = 0;
        } else {
          // Imbalance uses prefix before first reported loss onset, resolved at finish.
          let available = seconds;
          while (available > 1e-9) {
            if (pressureWindowSeconds === 0) pressureWindowStart = index;
            const used = Math.min(available, 1 - pressureWindowSeconds);
            for (let w = 0; w < 4; w++) {
              const pressure = packet[PRESSURE_FIELDS[w]]!;
              pressureSums[w] += pressure * used; pressureMin[w] = Math.min(pressureMin[w], pressure); pressureMax[w] = Math.max(pressureMax[w], pressure);
              const temperature = temperatureValue(packet, CORE_TEMPERATURE_FIELDS[WHEELS[w]]) ?? temperatureValue(packet, PRIMARY_TEMPERATURE_FIELDS[WHEELS[w]]);
              if (temperature !== undefined) { pressureTempSums[w] += celsius(temperature, packetUnit) * used; pressureTempSeconds[w] += used; }
            }
            pressureElapsed += used; pressureWindowSeconds += used; available -= used;
            if (pressureWindowSeconds < 1 - 1e-9) continue;
            while (pressureHistory.length && pressureElapsed - pressureHistory[0].seconds > 8) pressureHistory.shift();
            if (pressureMax.every((max, w) => max - pressureMin[w] <= 1)) {
              const current: PressureWindow = { seconds: pressureElapsed, frame: pressureWindowStart,
                pressures: pressureSums.map((sum) => sum / pressureWindowSeconds),
                temperatures: pressureTempSums.map((sum, w) => pressureTempSeconds[w] >= pressureWindowSeconds * .9 ? sum / pressureTempSeconds[w] : undefined) };
              let baseline: PressureWindow | undefined;
              if (pressureHistory.length >= 3 && pressureHistory[2].seconds - pressureHistory[0].seconds <= 2.1) {
                const [a,b,c] = pressureHistory;
                baseline = { seconds: b.seconds, frame: b.frame,
                  pressures: WHEELS.map((_,w) => median3(a.pressures[w],b.pressures[w],c.pressures[w])),
                  temperatures: WHEELS.map((_,w) => a.temperatures[w] === undefined || b.temperatures[w] === undefined || c.temperatures[w] === undefined ? undefined : median3(a.temperatures[w]!,b.temperatures[w]!,c.temperatures[w]!)) };
              }
              for (let w=0;w<4;w++) {
                if (pressureReported[w]) continue;
                const reference = pressurePending[w]?.baseline ?? baseline;
                if (!reference || (!pressurePending[w] && Math.max(...pressureHistory.slice(0,3).map((x)=>x.pressures[w])) - Math.min(...pressureHistory.slice(0,3).map((x)=>x.pressures[w])) > .75)) continue;
                const drop=reference.pressures[w]-current.pressures[w], peers=[1,2,3].map((offset)=>reference.pressures[(w+offset)%4]-current.pressures[(w+offset)%4]);
                const peerDrop=median3(peers[0],peers[1],peers[2]), before=reference.temperatures[w], after=current.temperatures[w];
                const cooling=before!==undefined&&after!==undefined?Math.max(0,(reference.pressures[w]+14.7)*(before-after)/(before+273.15)):0;
                if(drop<Math.max(2,reference.pressures[w]*.08)||drop-peerDrop<1.5||drop-cooling<1.5){pressurePending[w]=undefined;continue;}
                const candidate=pressurePending[w]??{baseline:reference,seconds:0,frame:current.frame};candidate.seconds+=pressureWindowSeconds;pressurePending[w]=candidate;
                if(candidate.seconds>=2-1e-9){pressureReported[w]=true;pressureResults[w]={id:`tire-rapid-pressure-loss-${WHEELS[w]}`,category:"tires",severity:"warning",label:"Rapid Tire Pressure Loss",detail:`${WHEELS[w]} pressure fell ${drop.toFixed(1)} psi to ${current.pressures[w].toFixed(1)} psi relative to its recent baseline and peer tires, sustained for at least 2 seconds — inspect the tire; cause is not confirmed`,frameIndices:[candidate.frame]};}
              }
              pressureHistory.push(current);
            } else pressurePending.fill(undefined);
            pressureSums.fill(0);pressureMin.fill(Infinity);pressureMax.fill(-Infinity);pressureTempSums.fill(0);pressureTempSeconds.fill(0);pressureWindowSeconds=0;
          }
        }
      }
    },
    finish() {
      const rapidPressureLoss = options.rapidPressureLoss ? [...options.rapidPressureLoss] : pressureResults.filter((value): value is LapInsight => !!value);
      const overheat: LapInsight[] = [], coreOverheat: LapInsight[] = [];
      for (let w = 0; w < 4; w++) {
        heatRuns[w].finish(); criticalRuns[w].finish();
        coreRuns[w].finish(); coreCriticalRuns[w].finish();
        const separateCore = options.separateCoreTemperature?.identity !== "primary";
        const emit = (run: EventRun, critical: EventRun, values: number[], core: boolean, packetUnit: TireTemperaturePacketUnit) => {
          if (!run.events.length) return;
          let peak = -Infinity;
          for (const [start, end] of run.events) {
            for (let i = start; i <= end; i++) peak = Math.max(peak, values[i] ?? -Infinity);
          }
          const scale = temperatureScale(packetUnit);
          const insight: LapInsight = {
            id: `${core ? "tire-core-overheat" : "tire-overheat"}-${WHEELS[w]}`,
            category: "tires", severity: critical.events.length ? "critical" : "warning",
            label: core ? "Tire Core Overheat" : "Tire Overheat",
            detail: `${WHEELS[w]}${core ? " core" : ""} exceeded ${110 * scale.factor + (packetUnit === "fahrenheit" ? 32 : 0)}${scale.unit} (peak ${peak.toFixed(0)}${scale.unit})`,
            frameIndices: midFrame(run.events),
          };
          (core && separateCore ? coreOverheat : overheat).push(insight);
        };
        if (options.primaryTemperature) emit(heatRuns[w], criticalRuns[w], heatValues[w], options.primaryTemperatureIdentity === "separate-core", options.primaryTemperatureUnit);
        if (options.separateCoreTemperature) emit(coreRuns[w], coreCriticalRuns[w], coreValues[w], separateCore, options.separateCoreTemperature.packetUnit);
      }
      const wears = finalWear ? WEAR_FIELDS.map((field) => finalWear![field]) : undefined;
      const wearDelta = wears?.some((value) => value < 0) ? 0 : wears ? Math.max(...wears) - Math.min(...wears) : 0;
      const wearImbalance: LapInsight | null = wears && wearDelta > 0.15 ? {
        id: "tire-wear-imbalance", category: "tires", severity: wearDelta > 0.3 ? "critical" : "warning",
        label: "Wear Imbalance",
        detail: `${WHEELS[wears.indexOf(Math.max(...wears))]} most worn, ${WHEELS[wears.indexOf(Math.min(...wears))]} least (${(wearDelta * 100).toFixed(0)}% spread)`,
        frameIndices: [telemetry.length - 1],
      } : null;
      let tempSplit: LapInsight | null = null;
      if (options.temperatureSplit && (options.primaryTemperature || options.separateCoreTemperature) &&
        tempSeconds >= 100 / 60 && Math.abs((tempFront - tempRear) / tempSeconds) >= 12) {
        const delta = (tempFront - tempRear) / tempSeconds;
        const scale = temperatureScale(splitUnit);
        tempSplit = {
          id: "tire-temp-split", category: "tires",
          severity: Math.abs(delta) > 22 ? "warning" : "info",
          label: "Front/Rear Temp Split",
          detail: `${delta > 0 ? "front" : "rear"} axle ${(Math.abs(delta) * scale.factor).toFixed(0)}${scale.unit} hotter on average — measured thermal balance, not a setup diagnosis`,
          frameIndices: [tempEvidence],
        };
      }
      if (pressurePrefix) {
        const prefixes = [0, 1].map((axle) => {
          const onset = rapidPressureLoss.reduce((first, insight) =>
            insight.id === `tire-rapid-pressure-loss-${WHEELS[axle * 2]}` ||
            insight.id === `tire-rapid-pressure-loss-${WHEELS[axle * 2 + 1]}`
              ? Math.min(first, ...insight.frameIndices) : first, Infinity);
          const frame = Math.min(telemetry.length, onset) - 1;
          return { total: pressurePrefix[axle].totals[frame] ?? 0,
            seconds: pressurePrefix[axle].seconds[frame] ?? 0,
            peakIndex: pressurePrefix[axle].peakIndices[frame] ?? 0 };
        });
        const front = prefixes[0].seconds >= 100 / 60 ? prefixes[0].total / prefixes[0].seconds : 0;
        const rear = prefixes[1].seconds >= 100 / 60 ? prefixes[1].total / prefixes[1].seconds : 0;
        const axle = Math.abs(front) >= Math.abs(rear) ? 0 : 1;
        const delta = axle === 0 ? front : rear;
        if (Math.abs(delta) >= 1.5) pressureImbalance = {
          id: "tire-pressure-imbalance", category: "tires",
          severity: Math.abs(delta) >= 3 ? "critical" : "warning", label: "Tire Pressure Imbalance",
          detail: `${axle === 0 ? "front" : "rear"} ${delta > 0 ? "left" : "right"} tire averaged ${Math.abs(delta).toFixed(1)} psi higher — compare pressure histories and cold settings`,
          frameIndices: [prefixes[axle].peakIndex],
        };
      }
      const surfaceProfile: LapInsight[] = [];
      for (let w = 0; w < 4; w++) {
        const windows = surfaceWindows[w];
        for (const kind of ["edge", "shape"] as const) {
          const signField = kind === "edge" ? "edgeSign" : "shapeSign";
          for (const sign of [-1, 1]) {
            const matches = windows.filter((window) => window[signField] === sign);
            const later = windows.slice(Math.floor(windows.length / 2));
            if (matches.length < 3 || matches.length < windows.length * 0.6 ||
              later.filter((window) => window[signField] === sign).length < later.length * 0.6) continue;
            const average = matches.reduce((sum, window) => sum + window[kind], 0) / matches.length;
            surfaceProfile.push({
              id: `tire-surface-${kind === "edge" ? "edge-imbalance" : "pressure-shape"}-${WHEELS[w]}`,
              category: "tires", severity: "info",
              label: kind === "edge" ? "Persistent Tire Edge Gradient" : "Persistent Tire Tread Gradient",
              detail: `${WHEELS[w]} ${kind === "edge" ? (sign > 0 ? "inner edge" : "outer edge") : (sign > 0 ? "center" : "shoulders")} averaged ${(Math.abs(average) * factor).toFixed(1)}${unit} hotter across ${matches.length} separated operating windows — observed thermal pattern, not a camber or pressure diagnosis`,
              frameIndices: matches.map((window) => window.frame),
            });
          }
        }
      }
      const result: OrderedInsight[] = [];
      appendInsights(result, INSIGHT_ORDER.overheat, overheat);
      appendInsights(result, INSIGHT_ORDER.coreOverheat, coreOverheat);
      appendInsights(result, INSIGHT_ORDER.surfaceProfile, surfaceProfile);
      appendInsights(result, INSIGHT_ORDER.wearImbalance, wearImbalance);
      appendInsights(result, INSIGHT_ORDER.tempSplit, tempSplit);
      appendInsights(result, INSIGHT_ORDER.rapidPressureLoss, rapidPressureLoss);
      appendInsights(result, INSIGHT_ORDER.pressureImbalance, pressureImbalance);
      return result;
    },
  };
}

function runTireScan(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  options: Parameters<typeof createTireScan>[2],
): OrderedInsight[] {
  return runSelectedInsightScan(telemetry, createTireScan(telemetry, packetUnit, options));
}

export function detectTireOverheat(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  layer: TireTemperatureLayer = "primary",
  identity: "primary" | "separate-core" = "primary",
): LapInsight[] {
  const core = layer === "core";
  const results = runTireScan(telemetry, packetUnit, {
    primaryTemperature: !core,
    primaryTemperatureUnit: packetUnit,
    separateCoreTemperature: core ? { packetUnit, identity } : undefined,
    primaryTemperatureIdentity: identity,
    surfaceProfile: false,
    pressureAnalysis: false,
  });
  return insightsAt(results, identity === "separate-core" ? INSIGHT_ORDER.coreOverheat : INSIGHT_ORDER.overheat);
}

export function detectWearImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runTireScan(telemetry, "celsius", {
    primaryTemperature: false, primaryTemperatureUnit: "celsius",
    surfaceProfile: false, pressureAnalysis: false,
  }), INSIGHT_ORDER.wearImbalance);
}

export function detectTireTempSplit(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  layer: TireTemperatureLayer = "primary",
): LapInsight | null {
  const core = layer === "core";
  return insightAt(runTireScan(telemetry, packetUnit, {
    primaryTemperature: !core, primaryTemperatureUnit: packetUnit,
    separateCoreTemperature: core ? { packetUnit } : undefined,
    temperatureSplit: true,
    surfaceProfile: false, pressureAnalysis: false,
  }), INSIGHT_ORDER.tempSplit);
}

export function detectTireSurfaceProfile(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
): LapInsight[] {
  return insightsAt(runTireScan(telemetry, packetUnit, {
    primaryTemperature: false, primaryTemperatureUnit: packetUnit,
    surfaceProfile: true, pressureAnalysis: false,
  }), INSIGHT_ORDER.surfaceProfile);
}

export function detectTirePressureImbalance(
  telemetry: TelemetryPacket[],
  rapidPressureLoss: readonly LapInsight[] = [],
): LapInsight | null {
  return insightAt(runTireScan(telemetry, "celsius", {
    primaryTemperature: false, primaryTemperatureUnit: "celsius",
    surfaceProfile: false, pressureAnalysis: true, rapidPressureLoss,
  }), INSIGHT_ORDER.pressureImbalance);
}

export function detectRapidPressureLoss(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit = "celsius",
): LapInsight[] {
  return insightsAt(runTireScan(telemetry, packetUnit, {
    primaryTemperature: false, primaryTemperatureUnit: packetUnit,
    surfaceProfile: false, pressureAnalysis: true,
  }), INSIGHT_ORDER.rapidPressureLoss);
}
