import { describe, expect, test } from "bun:test";
import { NO_DETECT_HINTS, listDetectHintSlugs, loadDetectHints } from "../../shared/racing/tracks/detect-hints";
import { getTrackRegistryIndexes } from "../../shared/racing/tracks/registry";
import { updateTrackRegistrySource } from "../../shared/racing/tracks/registry/update";

type Hint = { spans?: number; optional?: boolean };

const EXPECTED_HINTS: Record<string, Record<number, Hint>> = {
  austin: { 16: { spans: 3 } },
  baku: { 13: { optional: true }, 14: { optional: true } },
  "brands-hatch": { 7: { optional: true } },
  budapest: { 1: { spans: 2 } },
  catalunya: { 6: { optional: true }, 13: { optional: true }, 14: { optional: true }, 15: { optional: true }, 16: { spans: 2 } },
  donington: { 6: { optional: true } },
  hockenheim: { 4: { optional: true }, 5: { optional: true }, 11: { optional: true } },
  imola: { 1: { optional: true }, 8: { optional: true }, 10: { optional: true }, 13: { optional: true }, 16: { optional: true } },
  jeddah: { 19: { optional: true }, 25: { optional: true } },
  kyalami: { 3: { spans: 2 } },
  "laguna-seca": { 1: { optional: true }, 8: { spans: 2 } },
  "las-vegas": { 11: { optional: true } },
  lusail: { 11: { optional: true } },
  "mid-ohio": { 3: { optional: true } },
  monaco: { 6: { spans: 2 }, 12: { spans: 2 }, 17: { optional: true } },
  montreal: { 11: { optional: true } },
  "mount-panorama": { 4: { spans: 2 }, 10: { spans: 2 } },
  nurburgring: { 2: { spans: 2 } },
  "road-america": { 2: { optional: true }, 4: { optional: true } },
  "road-atlanta": { 5: { spans: 4 }, 8: { optional: true }, 10: { spans: 2 } },
  sakhir: { 15: { optional: true } },
  sebring: { 2: { optional: true }, 12: { optional: true }, 15: { spans: 2 } },
  shanghai: { 15: { optional: true } },
  silverstone: { 5: { optional: true }, 17: { spans: 2 } },
  spa: { 10: { spans: 2 }, 16: { optional: true } },
  spielberg: { 2: { optional: true }, 8: { optional: true } },
  suzuka: { 12: { spans: 2 } },
  vir: { 2: { optional: true } },
  "watkins-glen": { 5: { spans: 3 }, 8: { spans: 2 } },
  "yas-marina": { 13: { spans: 2 } },
  zandvoort: { 7: { spans: 2 }, 8: { spans: 2 }, 11: { spans: 2 }, 13: { optional: true }, 14: { spans: 2 } },
};

describe("detect hints", () => {
  test("preserves exact 31-layout, 60-turn detector allowances", () => {
    const slugs = Object.keys(EXPECTED_HINTS).sort();
    expect(listDetectHintSlugs()).toEqual(slugs);
    expect(Object.fromEntries(slugs.map((slug) => [slug, Object.fromEntries(loadDetectHints(slug))]))).toEqual(EXPECTED_HINTS);
    expect(Object.values(EXPECTED_HINTS).reduce((count, turns) => count + Object.keys(turns).length, 0)).toBe(60);
  });

  test("returns shared empty hints only for unhinted or absent layouts", () => {
    expect(loadDetectHints("nurburgring-nord")).toBe(NO_DETECT_HINTS);
    expect(loadDetectHints("unknown-layout")).toBe(NO_DETECT_HINTS);
  });

  test("maps every hinted facts slug to one layout", () => {
    const slugs = Object.keys(EXPECTED_HINTS).sort();
    const indexes = getTrackRegistryIndexes();
    expect(slugs.map((factsSlug) => ({ factsSlug, count: indexes.layoutsByFactsSlug.get(factsSlug)?.length ?? 0 }))).toEqual(
      slugs.map((factsSlug) => ({ factsSlug, count: 1 })),
    );
  });

  test("rejects ambiguous layout mappings in authored source", () => {
    expect(() =>
      updateTrackRegistrySource((draft) => {
        draft.configurations.layouts.push({
          id: "circuit-of-the-americas/duplicate",
          name: "Duplicate",
          factsSlug: "austin",
        });
      }),
    ).toThrow(/Facts austin belongs to multiple layouts/);
  });
});
