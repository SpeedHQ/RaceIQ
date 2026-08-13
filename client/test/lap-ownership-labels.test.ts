import { describe, expect, test } from "bun:test";
import type { LapMeta } from "@shared/racing/sessions/types";
import { buildAnalyseLapOption } from "../src/components/analyse/AnalyseLapHeader";
import { buildComparisonLapOption } from "../src/components/comparison/ComparisonSelectors";

const lap = (ownership: "mine" | "others", isValid = true) =>
  ({ id: 42, lapNumber: 7, lapTime: 62345, ownership, isValid } as LapMeta);

describe("lap ownership labels", () => {
  test("provides localized Mine and Others labels", () => {
    expect(buildAnalyseLapOption(lap("mine"), "en").label).toContain("Mine");
    expect(buildAnalyseLapOption(lap("others"), "en").label).toContain("Others");
    expect(buildAnalyseLapOption(lap("mine"), "de").label).toContain("Meine");
    expect(buildAnalyseLapOption(lap("others"), "de").label).toContain("Andere");
  });

  test("Analyse labels persisted Mine/Others ownership and invalid marker", () => {
    expect(buildAnalyseLapOption(lap("mine"), "en")).toMatchObject({ value: "42", label: expect.stringContaining("Mine") });
    expect(buildAnalyseLapOption(lap("others", false), "en").label).toContain("Others");
    expect(buildAnalyseLapOption(lap("others", false), "en").label).toContain("✕");
  });

  test("Compare A/B options expose persisted ownership in both locales", () => {
    for (const locale of ["en", "de"] as const) {
      expect(buildComparisonLapOption(lap("mine"), locale).label).toContain(locale === "en" ? "Mine" : "Meine");
      expect(buildComparisonLapOption(lap("others"), locale).label).toContain(locale === "en" ? "Others" : "Andere");
    }
  });
});
