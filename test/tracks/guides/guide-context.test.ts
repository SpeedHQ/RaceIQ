import { describe, test, expect } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { buildTrackGuideContext, guideCornerLabels, getAvailableTrackGuides } from "../../../server/ai/track-guides";

initGameAdapters();
initServerGameAdapters();

describe("guide corner naming defers to meta", () => {
  test("Monaco: guide's own names give way to meta's", () => {
    const out = buildTrackGuideContext("Monaco", { slug: "monaco" });
    expect(out).toContain("Piscine (14-15)"); expect(out).toContain("Fairmont Hairpin (6)");
    expect(out).not.toContain("Swimming Pool"); expect(out).not.toContain("Grand Hotel Hairpin");
  });
  test("Spa: accent/article drift resolves to the meta spelling", () => expect(buildTrackGuideContext("Spa", { slug: "spa" })).toContain("Les Fagnes"));
  test("priority corners use the same labels as the corner list", () => {
    const out = buildTrackGuideContext("Monaco", { slug: "monaco" });
    const priority = out.split("Priority corners (most impactful on lap time): ")[1]?.split("\n")[0] ?? "";
    expect(priority).toContain("Fairmont Hairpin (6)");
    for (const label of priority.split(", ")) expect(out).toContain(`• ${label} [`);
  });
  test("without a slug, falls back to the guide's own names (no crash)", () => {
    const out = buildTrackGuideContext("Monaco"); expect(out).toContain("Expert Track Guide"); expect(out).toContain("Swimming Pool");
  });
  test("guideCornerLabels matches the labels the context block emits", () => {
    const labels = guideCornerLabels("Monaco", { slug: "monaco" });
    const out = buildTrackGuideContext("Monaco", { slug: "monaco" });
    expect(labels.length).toBeGreaterThan(0); for (const l of labels) expect(out).toContain(`• ${l} [`);
  });
  test("unknown track yields no guide", () => {
    expect(buildTrackGuideContext("Wibble Speedway")).toBe(""); expect(guideCornerLabels("nonexistent-track")).toEqual([]);
  });
  test("meta merging two corners into one segment emits one bullet", () => {
    const out = buildTrackGuideContext("Monaco", { slug: "monaco" });
    expect(out.split("• Rascasse / Antony Noghès (18-19) [").length - 1).toBe(1);
  });
  test("every guide id resolves", () => expect(getAvailableTrackGuides().length).toBeGreaterThan(50));
});
