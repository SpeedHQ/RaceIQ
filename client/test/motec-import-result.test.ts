import { initGameAdapters } from "../../shared/games/init";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMotecLapTime, hasCompleteMotecSource } from "../src/components/analyse/motec-import-utils";
import * as motecImportResult from "../src/components/analyse/MotecImportModal";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });
test("formats imported lap times as seconds", () => {
  expect(formatMotecLapTime(143.637)).toBe("2:23.637");
  expect(formatMotecLapTime(138.146)).toBe("2:18.146");
});

test("accepts direct ZIPs and requires a sidecar for standalone LD files", () => {
  const archive = new File([], "session.zip");
  const log = new File([], "session.ld");
  const sidecar = new File([], "session.ldx");

  expect(hasCompleteMotecSource(archive, null)).toBe(true);
  expect(hasCompleteMotecSource(log, null)).toBe(false);
  expect(hasCompleteMotecSource(log, sidecar)).toBe(true);
  expect(hasCompleteMotecSource(null, null, "staged-token")).toBe(true);
});



test("renders limitations and canonical channels", () => {
  const MotecImportNote = Reflect.get(motecImportResult, "MotecImportNote");
  expect(typeof MotecImportNote).toBe("function");
  const markup = renderToStaticMarkup(createElement(MotecImportNote, {
    result: {
      imported: 1,
      gameId: "ac-evo",
      routePrefix: "ac-evo",
      laps: [{ lapId: 1, lapNumber: 1, lapTime: 120 }],
      meta: { driver: "Driver", venue: "Spa", vehicleId: "car" },
      capabilities: [
        { semanticId: "engine.current-engine-rpm", label: "Current Engine RPM", group: "Engine", available: true },
        { semanticId: "brakes.brake-bias", label: "Front brake bias", group: "Brakes", available: false },
      ],
      unavailableFeatures: [{ feature: "brakeBias", missingSemanticIds: ["brakes.brake-bias"] }],
      limitations: ["Racing line is estimated from speed and lateral G force because MoTeC does not record track position. Yaw rate controls car direction and is only used for the line if lateral G is unavailable. The estimate may drift."],
    },
    onClose: () => {},
  }));

  expect(markup).not.toContain("Features unavailable due to lack of data channels");
  expect(markup.indexOf("Racing line is estimated from speed and lateral G force because MoTeC does not record track position. Yaw rate controls car direction and is only used for the line if lateral G is unavailable. The estimate may drift.")).toBeGreaterThan(-1);
  expect(markup.indexOf("Racing line is estimated from speed and lateral G force because MoTeC does not record track position. Yaw rate controls car direction and is only used for the line if lateral G is unavailable. The estimate may drift.")).toBeLessThan(markup.indexOf("Canonical channels"));
  expect(markup).toContain("overflow-y-auto");
  expect(markup).toContain("Current Engine RPM");
  expect(markup).toContain("✓");
  expect(markup).toContain("×");
  expect(markup).toContain('aria-label="Available"');
  expect(markup).toContain('aria-label="Unavailable"');
});
test("lists MoTeC metric availability from cursor states", () => {
  const buildMotecMetricAvailability = Reflect.get(motecImportResult, "buildMotecMetricAvailability");
  expect(typeof buildMotecMetricAvailability).toBe("function");
  const result = buildMotecMetricAvailability({
    frame: {
      values: {
        "motion.speed": 10,
      },
      states: {
        "motion.speed": "ok",
        "engine.current-engine-rpm": "unavailable",
      },
    },
    gameId: "ac-evo",
  });
  expect(result.available.map((metric: { semanticId: string }) => metric.semanticId)).toContain("motion.speed");
  expect(result.unavailable.map((metric: { semanticId: string }) => metric.semanticId)).toContain("engine.current-engine-rpm");
});
