import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GameId } from "../../shared/games/ids";
import { initGameAdapters } from "../../shared/games/init";
import { CurrentLapTireStrip } from "../src/components/tunes/CurrentLapTireStrip";
import { LiveTestDashboard } from "../src/components/tunes/LiveTestDashboard";
import { buildSectorRanges, METRICS } from "../src/components/tunes/SectorRangeBreakdown";
import { tireSnapshot } from "../src/components/tunes/review/tire-snapshot";
import { semanticSamples } from "../src/components/tunes/semantic-tune";
import { buildGeometry } from "../src/components/tunes/track-map-geometry";
import type { SemanticReplayFrame } from "../src/hooks/laps";
import { fakeAccSemanticFixture, fakeF1SemanticFixture } from "../src/stories/fakeData";
import { useTelemetryStore } from "../src/stores/telemetry";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });

const TUNING_GAMES = ["acc", "ac-evo", "f1-2025"] as const;

function replayFrame(simulator: GameId, sequence: number, entries: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }>): SemanticReplayFrame {
  return {
    sequence,
    observedAt: { domain: "session", milliseconds: sequence * 10 },
    receivedAt: { domain: "session", milliseconds: sequence * 10 },
    simulator,
    values: entries,
  };
}

function entries(index: number, fuel: number) {
  return [
    { semanticId: "identity.track-ordinal", value: 7 },
    { semanticId: "motion.position-x", value: index * 10 },
    { semanticId: "motion.position-z", value: index * 5 },
    { semanticId: "motion.speed", value: 20 + index },
    { semanticId: "timing.distance-traveled", value: index * 25 },
    { semanticId: "tire.temperature.average", value: [80 + index, 81 + index, 82 + index, 83 + index] },
    { semanticId: "brakes.brake-temp", value: [300 + index, 301 + index, 250 + index, 251 + index] },
    { semanticId: "tires.tire-pressure", value: [27, 27.1, 26.5, 26.6] },
    { semanticId: "tires.tire-wear", value: [0, 0.1, 0.2, 0.3] },
    { semanticId: "fuel.fuel", value: fuel },
  ];
}

describe("canonical tuning telemetry consumers", () => {
  test("preserves simulator identity and explicit units across supported tuning games", () => {
    for (const gameId of TUNING_GAMES) {
      const fuel = gameId === "f1-2025" ? 0.5 : 50;
      const [sample] = semanticSamples(gameId, [replayFrame(gameId, 1, entries(1, fuel))]);
      expect(sample.gameId).toBe(gameId);
      expect(sample.positionM).toEqual({ x: 10, z: 5 });
      expect(sample.speedMps).toBe(21);
      expect(sample.tireTemperatureC?.fl).toBe(81);
      if (gameId === "f1-2025") {
        expect(sample.fuelFraction).toBe(0.5);
        expect(sample.fuelLiters).toBeUndefined();
      } else {
        expect(sample.fuelLiters).toBe(50);
        expect(sample.fuelFraction).toBeUndefined();
      }
    }
  });

  test("rejects stale, missing, partial, and wrong-simulator values without zero coercion", () => {
    const frame = replayFrame("acc", 1, [
      { semanticId: "motion.position-x", value: 0 },
      { semanticId: "motion.position-z", value: 0, state: "missing" },
      { semanticId: "tire.temperature.average", value: [0, 0, 0, 0], freshness: "stale" },
      { semanticId: "tires.tire-wear", value: [0, 0, 0, 0] },
    ]);
    const [sample] = semanticSamples("acc", [frame]);
    expect(sample.positionM).toBeUndefined();
    expect(sample.tireTemperatureC).toBeUndefined();
    expect(sample.tireWearFraction).toEqual({ fl: 0, fr: 0, rl: 0, rr: 0 });
    expect(semanticSamples("ac-evo", [frame])).toEqual([]);
  });

  test("renders equivalent tire ranges and game-correct fuel units", () => {
    const acc = semanticSamples(
      "acc",
      Array.from({ length: 6 }, (_, index) => replayFrame("acc", index, entries(index, 50 - index))),
    );
    const acEvo = semanticSamples(
      "ac-evo",
      Array.from({ length: 6 }, (_, index) => replayFrame("ac-evo", index, entries(index, 50 - index))),
    );
    const f1 = semanticSamples(
      "f1-2025",
      Array.from({ length: 6 }, (_, index) => replayFrame("f1-2025", index, entries(index, 0.8 - index * 0.02))),
    );
    const accMarkup = renderToStaticMarkup(createElement(CurrentLapTireStrip, { telemetry: acc }));
    const acEvoMarkup = renderToStaticMarkup(createElement(CurrentLapTireStrip, { telemetry: acEvo }));
    const f1Markup = renderToStaticMarkup(createElement(CurrentLapTireStrip, { telemetry: f1 }));
    expect(accMarkup).toBe(acEvoMarkup);
    expect(accMarkup).toContain(">L<");
    expect(f1Markup).toContain(">%<");
  });

  test("uses percent wear while preserving legitimate zero", () => {
    const samples = semanticSamples(
      "acc",
      Array.from({ length: 6 }, (_, index) => replayFrame("acc", index, entries(index, 50))),
    );
    const wearMetric = METRICS.find((metric) => metric.key === "wear")!;
    const model = buildSectorRanges(samples, null, wearMetric)!;
    expect(model.sectors[0].FL).toEqual({ min: 0, avg: 0, max: 0, n: 2 });
    expect(model.sectors[0].FR.avg).toBeCloseTo(10);
  });

  test("requires canonical position and tire values instead of fabricated zeroes", () => {
    const positioned = semanticSamples(
      "acc",
      Array.from({ length: 12 }, (_, index) => replayFrame("acc", index, entries(index, 50))),
    );
    expect(buildGeometry(positioned, null, null)?.pts).toHaveLength(12);
    const missingPosition = positioned.map((sample) => ({ ...sample, positionM: undefined }));
    expect(buildGeometry(missingPosition, null, null)).toBeNull();
    expect(tireSnapshot(positioned)?.FL.wear).toBe(0);
    expect(tireSnapshot(positioned.map((sample) => ({ ...sample, tireTemperatureC: undefined })))).toBeNull();
  });
  test("passes canonical lap number rather than running lap seconds", () => {
    useTelemetryStore.setState({ telemetryView: null, sectors: null, sessionLaps: [] });
    const view = {
      ...fakeAccSemanticFixture.view,
      identity: { ...fakeAccSemanticFixture.view.identity, trackOrdinal: undefined },
      timing: { ...fakeAccSemanticFixture.view.timing, lapNumber: 4, currentLapS: 92.146 },
    };
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(LiveTestDashboard, { gameId: "acc", trackOrdinal: null, initialViews: [view] })),
    );
    const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Lap 4");
    expect(text).not.toContain("Lap 92.146");
  });
  test("ignores live telemetry from a different simulator", () => {
    const accView = {
      ...fakeAccSemanticFixture.view,
      timing: { ...fakeAccSemanticFixture.view.timing, lapNumber: 4 },
    };
    const f1View = {
      ...fakeF1SemanticFixture.view,
      timing: { ...fakeF1SemanticFixture.view.timing, lapNumber: 99 },
    };
    useTelemetryStore.setState({ telemetryView: f1View, sectors: null, sessionLaps: [] });
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(LiveTestDashboard, { gameId: "acc", trackOrdinal: null, initialViews: [accView] })),
    );
    const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Lap 4");
    expect(text).not.toContain("Lap 99");
    expect(markup).toContain(">L<");
  });
});
