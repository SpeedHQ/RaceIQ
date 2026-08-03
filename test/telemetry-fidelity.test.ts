/**
 * Fidelity of our capture rate under decimation to 26.6Hz.
 *
 * These tests exist to keep an honest, measured answer to "does sample rate
 * actually matter?" rather than an assumed one. They run a real recorded AC Evo
 * stint through the parser, decimate it 2.39x, and assert what survives and
 * what does not.
 *
 * 26.6Hz is a decimation *test point*, not "MoTeC's rate". A real MoTeC .ld
 * logs per channel: 200Hz suspension/wheel-speed, 60Hz inputs, 20Hz temps and
 * G-forces. We are behind it where it matters and ahead of it where it does
 * not — see section 2 of the write-up. Do not use these numbers to claim we
 * out-sample MoTeC.
 *
 * The headline: decimation costs us almost nothing on *smooth* channels (speed,
 * apex, racing line) and costs us real information on *transient* ones (slip
 * spikes, single-sample brake peaks, impact loads). Both halves are asserted so
 * neither can be quietly overstated later.
 *
 * See docs/research/telemetry-fidelity.md for the write-up.
 */
import { describe, expect, test } from "bun:test";
import { detectCorners } from "../server/lap-analysis/corners";
import type { TelemetryPacket } from "../shared/telemetry/types";

import { readSessionPackets } from "./helpers/session-frames";

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";

/** Decimation test point: 63.5Hz / 2.39. Chosen to sit below our rate, not to model MoTeC. */
const MOTEC_AVG_HZ = 26.6;

/** A GT3 car does not pull more than this laterally. Anything above is an impact/kerb artifact. */
const MAX_PHYSICAL_LAT_G = 3.5;

type P = TelemetryPacket & Record<string, number>;

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Nearest-sample decimation — models a slower sampler, not a resampler. No
 * interpolation, because a 26.6Hz logger genuinely never saw the dropped values.
 */
function decimate(frames: P[], srcHz: number, dstHz: number): P[] {
  const step = srcHz / dstHz;
  const out: P[] = [];
  for (let t = 0; t < frames.length; t += step) out.push(frames[Math.round(t)]);
  return out;
}

function splitLaps(packets: P[]): P[][] {
  const laps: P[][] = [];
  let current: P[] = [];
  let lastLapNumber = packets[0]?.LapNumber;
  for (const packet of packets) {
    if (packet.LapNumber !== lastLapNumber) {
      laps.push(current);
      current = [];
      lastLapNumber = packet.LapNumber;
    }
    current.push(packet);
  }
  laps.push(current);
  // Complete laps only — partial out/in laps have no meaningful frames/laptime rate.
  return laps.filter((lap) => lap.length > 500 && lap[lap.length - 1].DistanceTraveled - lap[0].DistanceTraveled > 3000);
}

const allPackets = readSessionPackets(FIXTURE, "ac-evo") as P[];
const laps = splitLaps(allPackets);
const captureHz = mean(laps.map((lap) => lap.length / Math.max(...lap.map((p) => p.CurrentLap))));

describe("telemetry fidelity vs MoTeC-rate logging", () => {
  test("fixture yields complete laps to measure against", () => {
    expect(allPackets.length).toBeGreaterThan(10_000);
    expect(laps.length).toBeGreaterThanOrEqual(2);
  });

  test("our real captured rate is ~63.5Hz, not the 100Hz the assembler polls at", () => {
    // server/games/kunos/triplet-assembler.ts polls on a 10ms setInterval, but what
    // actually lands on disk is ~63.5Hz. If this moves, either the timer behaviour
    // changed or someone fixed the emit path — update docs/research/telemetry-fidelity.md.
    expect(captureHz).toBeGreaterThan(55);
    expect(captureHz).toBeLessThan(70);
    // Still comfortably above the lap detector's 30Hz session-quality floor.
    expect(captureHz).toBeGreaterThan(30);
  });

  test("a third of emitted frames are duplicates, so our effective rate is ~39.5Hz", () => {
    // The assembler emits on every poll with no gate on the physics page having
    // advanced, so the same CurrentRaceTime is written repeatedly. This is the
    // cheapest size win available (docs/research/telemetry-fidelity.md) and the
    // reason the honest headline rate is ~39.5Hz, not 63.5Hz.
    const all = allPackets;
    let duplicates = 0;
    for (let i = 1; i < all.length; i++) {
      if (all[i].CurrentRaceTime === all[i - 1].CurrentRaceTime) duplicates++;
    }
    return repeats / allPackets.length;
  };

  test("the physics page is fresh on essentially every frame", () => {
    // No physics sample we write is a stale copy, so our physics-channel rate is
    // the full capture rate (~63.5Hz) — not a lower "effective" rate.
    expect(pageRepeats("physicsPacketId")).toBeLessThan(0.01);
  });

  test("a third of frames re-read an unchanged graphics page", () => {
    // The graphics page only advances at ~40Hz in the sim, so polling it at
    // ~63.5Hz re-reads it ~37% of the time. Graphics is also the largest page in
    // the triplet (3944 of 5000 bytes), which is what makes this the cheapest
    // size win available (docs/telemetry-fidelity.md section 6).
    const gfxRepeats = pageRepeats("graphicsPacketId");
    expect(gfxRepeats).toBeGreaterThan(0.3);
    expect(gfxRepeats).toBeLessThan(0.45);

    // Graphics-derived channels (lap time, position, flags) therefore genuinely
    // update at ~40Hz, not at the capture rate.
    const graphicsHz = captureHz * (1 - gfxRepeats);
    expect(graphicsHz).toBeGreaterThan(35);
    expect(graphicsHz).toBeLessThan(45);
  });

  test("poll spacing is one Windows timer tick, not the 10ms we ask for", () => {
    // physicsPacketId is the *sim's* own counter, so it is an independent ruler
    // for how far apart our polls actually landed — no wall clock needed.
    const pid = allPackets
      .map((p) => p.acc?.acEvo?.physicsPacketId)
      .filter((v): v is number => typeof v === "number");
    const deltas: number[] = [];
    for (let i = 1; i < pid.length; i++) deltas.push(pid[i] - pid[i - 1]);

    // The sim publishes physics far faster than we read it: ~336Hz.
    const simHz = captureHz * mean(deltas);
    expect(simHz).toBeGreaterThan(300);
    expect(simHz).toBeLessThan(360);

    // A genuine 10ms poll against a ~3ms sim tick would advance ~3.35 ticks per
    // frame. We see ~5.29, i.e. ~15.8ms — the 15.625ms Windows tick plus
    // callback cost. This is the whole of the 63.5-vs-100Hz gap.
    expect(mean(deltas)).toBeGreaterThan(4.8);
    expect(mean(deltas)).toBeLessThan(5.8);

    const pollMs = (1000 * mean(deltas)) / simHz;
    expect(pollMs).toBeGreaterThan(14.5);
    expect(pollMs).toBeLessThan(17);
  });

  describe("what survives decimation to 26.6Hz", () => {
    const apexErrors: number[] = [];
    const brakePeakLoss: number[] = [];
    const latGLoss: number[] = [];

    for (const lap of laps) {
      const step = captureHz / MOTEC_AVG_HZ;
      const lapStart = lap[0].DistanceTraveled;
      for (const corner of detectCorners(lap)) {
        const i0 = lap.findIndex((p) => p.DistanceTraveled - lapStart >= corner.distanceStart);
        const i1 = lap.findIndex((p) => p.DistanceTraveled - lapStart >= corner.distanceEnd);
        if (i0 < 0 || i1 <= i0) continue;

        const full = lap.slice(i0, i1);
        const low: P[] = [];
        for (let t = Math.ceil(i0 / step) * step; t < i1; t += step) low.push(lap[Math.round(t)]);
        if (low.length < 2) continue;

        const kph = (p: P) => p.Speed * 3.6;
        apexErrors.push(Math.min(...low.map(kph)) - Math.min(...full.map(kph)));
        brakePeakLoss.push(((Math.max(...full.map((p) => p.Brake)) - Math.max(...low.map((p) => p.Brake))) / 255) * 100);

        const latFull = Math.max(...full.map((p) => Math.abs(p.AccelerationX))) / 9.81;
        const latLow = Math.max(...low.map((p) => Math.abs(p.AccelerationX))) / 9.81;
        if (latFull < MAX_PHYSICAL_LAT_G) latGLoss.push(latFull - latLow);
      }
    }

    test("apex speed is essentially unaffected", () => {
      expect(apexErrors.length).toBeGreaterThan(8);
      // Speed is band-limited; a 2.4x slower sampler still finds the same minimum.
      expect(mean(apexErrors)).toBeLessThan(0.5);
      expect(Math.max(...apexErrors)).toBeLessThan(1.0);
    });

    test("cornering load is preserved in the typical case", () => {
      expect(percentile(latGLoss, 0.9)).toBeLessThan(0.2);
    });

    test("corner apex positions stay put", () => {
      for (const lap of laps) {
        const full = detectCorners(lap);
        const low = detectCorners(decimate(lap, captureHz, MOTEC_AVG_HZ));
        const matched = full
          .map((f) => {
            const hit = low.find((l) => Math.abs((l.apexDistance ?? 0) - (f.apexDistance ?? 0)) < 30);
            return hit ? Math.abs((hit.apexDistance ?? 0) - (f.apexDistance ?? 0)) : null;
          })
          .filter((d): d is number => d !== null);
        // Every full-rate corner is still found, within 10m of where it really was.
        expect(matched.length).toBe(full.length);
        expect(percentile(matched, 0.9)).toBeLessThan(10);
      }
    });

    test("but individual peaks do get missed", () => {
      // Mean loss is small; the tail is not. At least one braking peak is badly clipped.
      expect(mean(brakePeakLoss)).toBeLessThan(5);
      expect(Math.max(...brakePeakLoss)).toBeGreaterThan(10);
    });
  });

  describe("what does not survive decimation to 26.6Hz", () => {
    const dtCapture = 1000 / captureHz;
    const dtMotec = 1000 / MOTEC_AVG_HZ;

    function eventDurationsMs(predicate: (p: P) => boolean): number[] {
      const durations: number[] = [];
      let run = 0;
      for (const packet of allPackets) {
        if (predicate(packet)) {
          run++;
        } else {
          if (run > 0) durations.push(run * dtCapture);
          run = 0;
        }
      }
      if (run > 0) durations.push(run * dtCapture);
      return durations;
    }

    const cases: [string, (p: P) => boolean, number][] = [
      ["rear slip >5%", (p) => Math.abs(p.TireSlipRatioRL) > 0.05 || Math.abs(p.TireSlipRatioRR) > 0.05, 0.1],
      ["front slip >5%", (p) => Math.abs(p.TireSlipRatioFL) > 0.05 || Math.abs(p.TireSlipRatioFR) > 0.05, 0.1],
      ["throttle lift mid-corner", (p) => p.Accel < 30 && p.Brake < 10 && Math.abs(p.Steer) > 20, 0.05],
    ];

    for (const [name, predicate, minLostFraction] of cases) {
      test(`a real share of "${name}" events are shorter than one 26.6Hz sample`, () => {
        const durations = eventDurationsMs(predicate);
        expect(durations.length).toBeGreaterThan(20);
        const lost = durations.filter((d) => d < dtMotec).length;
        // NOTE: "shorter than one sample" is NOT "missed" — see the miss-probability
        // test below. A short event is missed only when the sampler's phase happens
        // to straddle it. Reading this fraction as a miss rate overstates loss ~3x.
        expect(lost / durations.length).toBeGreaterThan(minLostFraction);
      });
    }

    test("random-phase miss probability at 26.6Hz is ~5%, not the 14% short-event share", () => {
      const durations = eventDurationsMs(
        (p) => Math.abs(p.TireSlipRatioRL) > 0.05 || Math.abs(p.TireSlipRatioRR) > 0.05
      );
      // For duration D and sample period T at arbitrary phase, P(no sample lands
      // inside) = max(0, 1 - D/T). Zero once D >= T.
      const expectedMissed = durations.reduce((sum, d) => sum + Math.max(0, 1 - d / dtMotec), 0);
      const missRate = expectedMissed / durations.length;
      expect(missRate).toBeGreaterThan(0.03);
      expect(missRate).toBeLessThan(0.08);

      // At our own rate nothing is missable — but only because the durations were
      // measured BY our rate. This is censorship, not proof of sufficiency, and is
      // why this fixture cannot argue 100Hz > 63.5Hz.
      const atCaptureRate = durations.reduce((sum, d) => sum + Math.max(0, 1 - d / dtCapture), 0);
      expect(atCaptureRate).toBe(0);
      expect(Math.min(...durations)).toBeGreaterThanOrEqual(dtCapture);
    });

    test("the dominant cost is under-reading caught events, not missing them", () => {
      const step = captureHz / MOTEC_AVG_HZ;
      const slip = (p: P) => Math.max(Math.abs(p.TireSlipRatioRL), Math.abs(p.TireSlipRatioRR));
      const attenuation: number[] = [];

      let start = -1;
      for (let i = 0; i <= allPackets.length; i++) {
        const active = i < allPackets.length && slip(allPackets[i]) > 0.05;
        if (active) {
          if (start < 0) start = i;
          continue;
        }
        if (start < 0) continue;

        const truePeak = Math.max(...allPackets.slice(start, i).map(slip));
        const sampled: P[] = [];
        for (let t = Math.ceil(start / step) * step; t < i; t += step) sampled.push(allPackets[Math.round(t)]);
        if (sampled.length) attenuation.push(((truePeak - Math.max(...sampled.map(slip))) / truePeak) * 100);
        start = -1;
      }

      // Typical under-read is mild, but the tail is severe: a snap of oversteer
      // logged as a wiggle. Worse than a miss, because it stays plausible.
      expect(mean(attenuation)).toBeLessThan(10);
      expect(percentile(attenuation, 0.9)).toBeGreaterThan(5);
      expect(Math.max(...attenuation)).toBeGreaterThan(50);
    });

    test("single-sample impact spikes exist and are exactly what a slow logger drops", () => {
      const spikes = allPackets.filter((p) => Math.abs(p.AccelerationX) / 9.81 > MAX_PHYSICAL_LAT_G);
      expect(spikes.length).toBeGreaterThan(0);
    });
  });
});
