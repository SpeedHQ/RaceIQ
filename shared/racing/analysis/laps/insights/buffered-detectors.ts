import type { TelemetryPacket } from "../../../../telemetry/types";
import type { AllWheelStates } from "../physics/vehicle";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";
import { appendInsights, INSIGHT_ORDER, EventRun, midFrame, type LapInsight, type OrderedInsight } from "./types";

const WHEELS = ["FL", "FR", "RL", "RR"] as const;

export function createBufferedScan(
  telemetry: readonly TelemetryPacket[],
  physicalSuspensionStroke: boolean,
  wheelStatesEnabled = false,
): InsightAccumulator {
  const overloadRuns = physicalSuspensionStroke ? WHEELS.map(() => new EventRun(0.05)) : undefined;
  const lockRuns = wheelStatesEnabled ? WHEELS.map(() => new EventRun(5 / 60, 0.25)) : undefined;
  const spinRuns = wheelStatesEnabled ? WHEELS.map(() => new EventRun(5 / 60, 0.25)) : undefined;
  const brakeRun = wheelStatesEnabled ? new EventRun(3 / 60, 15 / 60) : undefined;
  const throttleRun = wheelStatesEnabled ? new EventRun(3 / 60, 15 / 60) : undefined;
  const counterRun = new EventRun(3 / 60, 10 / 60);
  let totalDelta = 0;
  let seconds = 0;
  let peakIdx = 0;
  let peakVal = 0;
  let peakRpm = 0;
  let peakGear = 0;

  return {
    observe(index: number, duration: number, _previousSeconds: number, wheelState?: AllWheelStates): void {
      const p = telemetry[index];
      if (overloadRuns) {
        const moving = p.Speed > 7;
        const fl = p.NormSuspensionTravelFL, fr = p.NormSuspensionTravelFR;
        const rl = p.NormSuspensionTravelRL, rr = p.NormSuspensionTravelRR;
        overloadRuns[0].feed(index, duration, Number.isFinite(fl) && fl > 0.95 && moving);
        overloadRuns[1].feed(index, duration, Number.isFinite(fr) && fr > 0.95 && moving);
        overloadRuns[2].feed(index, duration, Number.isFinite(rl) && rl > 0.95 && moving);
        overloadRuns[3].feed(index, duration, Number.isFinite(rr) && rr > 0.95 && moving);
        if (duration > 0 && moving && Math.abs(p.AccelerationX) < 1 && Math.abs(p.Steer) < 15 && p.Brake < 25) {
          const left = (fl + rl) / 2, right = (fr + rr) / 2;
          if (Number.isFinite(left) && Number.isFinite(right)) {
            totalDelta += (left - right) * duration;
            seconds += duration;
          }
        }
      }
      if (wheelStatesEnabled && lockRuns && spinRuns && brakeRun && throttleRun && wheelState) {
        const flLock = wheelState.fl.state === "lockup", frLock = wheelState.fr.state === "lockup";
        const rlLock = wheelState.rl.state === "lockup", rrLock = wheelState.rr.state === "lockup";
        const flSpin = wheelState.fl.state === "spin", frSpin = wheelState.fr.state === "spin";
        const rlSpin = wheelState.rl.state === "spin", rrSpin = wheelState.rr.state === "spin";
        lockRuns[0].feed(index, duration, flLock); lockRuns[1].feed(index, duration, frLock);
        lockRuns[2].feed(index, duration, rlLock); lockRuns[3].feed(index, duration, rrLock);
        spinRuns[0].feed(index, duration, flSpin); spinRuns[1].feed(index, duration, frSpin);
        spinRuns[2].feed(index, duration, rlSpin); spinRuns[3].feed(index, duration, rrSpin);
        brakeRun.feed(index, duration, p.Brake >= 30 && (flLock || frLock || rlLock || rrLock));
        throttleRun.feed(index, duration, p.Accel >= 150 && (flSpin || frSpin || rlSpin || rrSpin));
      }
      counterRun.feed(index, duration, !(p.Speed * 2.23694 < 20) && Math.abs(p.AngularVelocityY) > 0.3 &&
        Math.abs(p.Steer) > 20 && Math.sign(p.AngularVelocityY) !== Math.sign(p.Steer));
      if (p.Power > peakVal) {
        peakVal = p.Power;
        peakIdx = index;
        peakRpm = p.CurrentEngineRpm;
        peakGear = p.Gear;
      }
    },
    finish(): OrderedInsight[] {
      const overload: LapInsight[] = [];
      if (overloadRuns) for (let w = 0; w < 4; w++) {
        overloadRuns[w].finish();
        const events = overloadRuns[w].events;
        if (events.length > 0) overload.push({
          id: `susp-overload-${WHEELS[w]}`, category: "suspension",
          severity: events.length >= 3 ? "critical" : "warning", label: "Suspension Overload",
          detail: `${WHEELS[w]} reached more than 95% of suspension travel in ${events.length} zone${events.length > 1 ? "s" : ""}`,
          frameIndices: midFrame(events),
        });
      }
      const lockups: LapInsight[] = [], wheelspin: LapInsight[] = [];
      if (lockRuns && spinRuns) for (let w = 0; w < 4; w++) {
        lockRuns[w].finish(); spinRuns[w].finish();
        const locks = lockRuns[w], spins = spinRuns[w];
        if (locks.events.length > 0) lockups.push({
          id: `tire-lockup-${WHEELS[w]}`, category: "tires", severity: locks.acceptedSeconds >= 1 ? "critical" : "warning",
          label: "Wheel Lockup", detail: `${WHEELS[w]} locked ${locks.events.length} time${locks.events.length > 1 ? "s" : ""}`,
          frameIndices: midFrame(locks.events),
        });
        if (spins.events.length > 0) wheelspin.push({
          id: `tire-spin-${WHEELS[w]}`, category: "tires", severity: spins.acceptedSeconds >= 1 ? "critical" : "warning",
          label: "Wheelspin", detail: `${WHEELS[w]} spun ${spins.events.length} time${spins.events.length > 1 ? "s" : ""}`,
          frameIndices: midFrame(spins.events),
        });
      }
      brakeRun?.finish(); throttleRun?.finish();
      const brakeEvents = brakeRun?.events ?? [], throttleEvents = throttleRun?.events ?? [];
      const brakeTractionLoss: LapInsight | null = brakeEvents.length ? {
        id: "driving-brake-traction-loss", category: "driving",
        severity: brakeEvents.length >= 5 ? "critical" : brakeEvents.length >= 2 ? "warning" : "info",
        label: "Brake Traction Loss", detail: `${brakeEvents.length} lockup${brakeEvents.length > 1 ? "s" : ""} under braking`, frameIndices: midFrame(brakeEvents),
      } : null;
      const throttleTractionLoss: LapInsight | null = throttleEvents.length ? {
        id: "driving-throttle-traction-loss", category: "driving",
        severity: throttleEvents.length >= 5 ? "critical" : throttleEvents.length >= 2 ? "warning" : "info",
        label: "Throttle Traction Loss", detail: `${throttleEvents.length} wheelspin event${throttleEvents.length > 1 ? "s" : ""} under power`, frameIndices: midFrame(throttleEvents),
      } : null;
      const avgDelta = totalDelta / seconds;
      const imbalance: LapInsight | null = seconds >= 2 && Math.abs(avgDelta) > 0.15 ? {
        id: "susp-imbalance", category: "suspension", severity: Math.abs(avgDelta) > 0.25 ? "critical" : "warning",
        label: "Suspension Imbalance",
        detail: `${avgDelta > 0 ? "left" : "right"} side compressed ${(Math.abs(avgDelta) * 100).toFixed(0)}% more during low-lateral-load running; road banking and setup can both contribute`,
        frameIndices: [Math.round(telemetry.length / 2)],
      } : null;
      counterRun.finish();
      const corrections = counterRun.events;
      const counterSteer: LapInsight | null = corrections.length ? {
        id: "driving-counter-steer", category: "driving",
        severity: corrections.length >= 5 ? "critical" : corrections.length >= 2 ? "warning" : "info",
        label: "Counter-Steer", detail: `${corrections.length} correction${corrections.length > 1 ? "s" : ""} — Loss of rear traction`, frameIndices: midFrame(corrections),
      } : null;
      const peakPower: LapInsight | null = peakVal !== 0 ? {
        id: "mech-peak-power", category: "mechanical", severity: "info", label: "Peak Power",
        detail: `${(peakVal / 745.7).toFixed(0)} hp @ ${peakRpm.toFixed(0)} RPM (gear ${peakGear})`, frameIndices: [peakIdx],
      } : null;
      const result: OrderedInsight[] = [];
      appendInsights(result, INSIGHT_ORDER.overload, overload);
      appendInsights(result, INSIGHT_ORDER.imbalance, imbalance);
      appendInsights(result, INSIGHT_ORDER.lockups, lockups);
      appendInsights(result, INSIGHT_ORDER.wheelspin, wheelspin);
      appendInsights(result, INSIGHT_ORDER.brakeTractionLoss, brakeTractionLoss);
      appendInsights(result, INSIGHT_ORDER.throttleTractionLoss, throttleTractionLoss);
      appendInsights(result, INSIGHT_ORDER.counterSteer, counterSteer);
      appendInsights(result, INSIGHT_ORDER.peakPower, peakPower);
      return result;
    },
  };
}

export function detectBufferedInsights(
  telemetry: readonly TelemetryPacket[],
  dt: readonly number[],
  physicalSuspensionStroke: boolean,
  wheelStates?: readonly AllWheelStates[],
): OrderedInsight[] {
  return runSelectedInsightScan(telemetry, createBufferedScan(telemetry, physicalSuspensionStroke, wheelStates !== undefined), {
    durations: dt,
    wheelStates,
  });
}
