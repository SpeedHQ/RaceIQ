import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMotecLapTime, formatUnavailableFeatures } from "../src/components/analyse/MotecImportModal";
import * as motecImportResult from "../src/components/analyse/MotecImportModal";

test("formats imported lap times as seconds", () => {
  expect(formatMotecLapTime(143.637)).toBe("2:23.637");
  expect(formatMotecLapTime(138.146)).toBe("2:18.146");
});


test("formats disabled features from missing canonical requirements", () => {
  expect(formatUnavailableFeatures([
    { feature: "balance", missingSemanticIds: ["tires.tire-slip-angle"] },
    { feature: "brakeBias", missingSemanticIds: ["brakes.brake-bias"] },
  ])).toEqual([
    "Balance — missing tires.tire-slip-angle",
    "Brake Bias — missing brakes.brake-bias",
  ]);
});

test("renders unavailable features above limitations and canonical channels", () => {
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
      limitations: ["Racing line is estimated from speed and rotation, not recorded directly."],
    },
    onClose: () => {},
  }));

  expect(markup).toContain("Features unavailable due to lack of data channels");
  expect(markup.indexOf("Features unavailable due to lack of data channels")).toBeLessThan(markup.indexOf("Racing line is estimated from speed and rotation, not recorded directly."));
  expect(markup.indexOf("Racing line is estimated from speed and rotation, not recorded directly.")).toBeLessThan(markup.indexOf("Canonical channels"));
  expect(markup).toContain("overflow-y-auto");
  expect(markup).toContain("Current Engine RPM");
  expect(markup).toContain("✓");
  expect(markup).toContain("×");
  expect(markup).toContain('aria-label="Available"');
  expect(markup).toContain('aria-label="Unavailable"');
});
