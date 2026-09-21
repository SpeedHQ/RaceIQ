import { semanticNumber, semanticWheelNumbers, type SemanticAnalysisFrame } from "./track-map/types";

export interface ChartData {
  speed: number[];
  throttle: number[];
  brake: number[];
  rpm: number[];
  steering: number[];
  timeFracs: number[];
  times: number[];
  tireTempFL: number[];
  tireTempFR: number[];
  tireTempRL: number[];
  tireTempRR: number[];
  tireCoreTempFL?: number[];
  tireCoreTempFR?: number[];
  tireCoreTempRL?: number[];
  tireCoreTempRR?: number[];
  drs?: number[];
  ersStore?: number[];
  ersDeployed?: number[];
  brakeTempFL?: number[];
  brakeTempFR?: number[];
  brakeTempRL?: number[];
  brakeTempRR?: number[];
}

function wheel(frame: SemanticAnalysisFrame, id: Parameters<typeof semanticNumber>[1], index: number): number | null {
  const value = frame.values[id];
  return Array.isArray(value) ? semanticWheelNumbers(frame, id)[index] : semanticNumber(frame, id);
}

export function buildChartData(
  semanticFrames: SemanticAnalysisFrame[],
  tireTemperatureSemanticId: Parameters<typeof semanticNumber>[1] = "tire.temperature.surface.representative",
  temperatureConverter: (celsius: number) => number = (celsius) => celsius,
): ChartData | null {
  if (semanticFrames.length === 0) return null;
  const speed: number[] = [], throttle: number[] = [], brake: number[] = [], rpm: number[] = [], steering: number[] = [];
  const tireTempFL: number[] = [], tireTempFR: number[] = [], tireTempRL: number[] = [], tireTempRR: number[] = [];
  const tireCoreTempFL: number[] = [], tireCoreTempFR: number[] = [], tireCoreTempRL: number[] = [], tireCoreTempRR: number[] = [];
  const times = semanticFrames.map((frame) => semanticNumber(frame, "timing.current-lap") ?? NaN);
  const firstTime = times[0];
  const maxTime = Math.max(...times.filter(Number.isFinite), firstTime);
  const lapDuration = maxTime - firstTime || 1;
  let previousTimeFrac = 0;
  const timeFracs = times.map((time) => {
    if (!Number.isFinite(time)) return NaN;
    previousTimeFrac = Math.max(previousTimeFrac, Math.max(0, (time - firstTime) / lapDuration));
    return previousTimeFrac;
  });
  let hasBrakeTemp = false;
  let hasCoreTemp = false;
  let hasTireTemp = false;
  const brakeTempFL: number[] = [], brakeTempFR: number[] = [], brakeTempRL: number[] = [], brakeTempRR: number[] = [];
  for (const frame of semanticFrames) {
    speed.push(semanticNumber(frame, "motion.speed") ?? NaN);
    throttle.push(semanticNumber(frame, "inputs.accel") ?? NaN);
    brake.push(semanticNumber(frame, "inputs.brake") ?? NaN);
    rpm.push(semanticNumber(frame, "engine.current-engine-rpm") ?? NaN);
    steering.push(semanticNumber(frame, "inputs.steer") ?? NaN);
    const temperatures = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, tireTemperatureSemanticId, index);
      return value == null ? null : temperatureConverter(value);
    });
    tireTempFL.push(temperatures[0] ?? NaN);
    tireTempFR.push(temperatures[1] ?? NaN);
    tireTempRL.push(temperatures[2] ?? NaN);
    tireTempRR.push(temperatures[3] ?? NaN);
    if (temperatures.some((value) => value != null)) hasTireTemp = true;
    const core = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, "tire.temperature.core", index);
      return value == null ? null : temperatureConverter(value);
    });
    tireCoreTempFL.push(core[0] ?? NaN);
    tireCoreTempFR.push(core[1] ?? NaN);
    tireCoreTempRL.push(core[2] ?? NaN);
    tireCoreTempRR.push(core[3] ?? NaN);
    if (core.some((value) => value != null)) hasCoreTemp = true;
    const brakes = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, "brakes.brake-temp", index);
      return value == null ? null : temperatureConverter(value);
    });
    brakeTempFL.push(brakes[0] ?? NaN);
    brakeTempFR.push(brakes[1] ?? NaN);
    brakeTempRL.push(brakes[2] ?? NaN);
    brakeTempRR.push(brakes[3] ?? NaN);
    if (brakes.some((value) => value != null)) hasBrakeTemp = true;
  }
  return {
    speed, throttle, brake, rpm, steering, timeFracs, times, tireTempFL, tireTempFR, tireTempRL, tireTempRR,
    ...(hasTireTemp && hasCoreTemp && tireTemperatureSemanticId === "tire.temperature.surface.representative" ? { tireCoreTempFL, tireCoreTempFR, tireCoreTempRL, tireCoreTempRR } : {}),
    ...(hasBrakeTemp ? { brakeTempFL, brakeTempFR, brakeTempRL, brakeTempRR } : {}),
  };
}
