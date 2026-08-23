import { describe, expect, test } from "bun:test";
import {
  NO_DETECT_HINTS,
  listDetectHintSlugs,
  loadDetectHints,
} from "../../shared/racing/tracks/detect-hints";
import { getTrackRegistry, writeGeneratedTrackRegistry } from "../../shared/racing/tracks/registry";

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
    const rows = getTrackRegistry().query(`
      SELECT facts_slug AS factsSlug, COUNT(*) AS count
        FROM layouts
       WHERE facts_slug IN (${slugs.map(() => "?").join(", ")})
       GROUP BY facts_slug
       ORDER BY facts_slug
    `).all(...slugs) as Array<{ factsSlug: string; count: number }>;
    expect(rows).toEqual(slugs.map((factsSlug) => ({ factsSlug, count: 1 })));
  });

  test("rejects ambiguous layout mappings", () => {
    // Bump loader cache revision before opening rollback-only nested transaction.
    writeGeneratedTrackRegistry(() => {});
    writeGeneratedTrackRegistry((database) => {
      const rollback = new Error("rollback detect-hints ambiguity fixture");
      try {
        database.transaction(() => {
          database.query(`
            INSERT INTO layouts (canonical_id, venue_path, slug, name, facts_slug)
            VALUES ('detect-hints-test/duplicate', 'circuit-of-the-americas', 'detect-hints-test-duplicate', 'Duplicate', 'austin')
          `).run();
          expect(() => loadDetectHints("austin")).toThrow('Ambiguous detect hints layout for facts slug "austin"');
          throw rollback;
        })();
      } catch (error) {
        if (error !== rollback) throw error;
      }
    });
  });
});
