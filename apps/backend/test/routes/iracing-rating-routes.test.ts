import { describe, expect, test } from "bun:test";
import { parseRecentRaceRows } from "../../src/routes/iracing-rating-routes";

describe("iRacing recent race parser", () => {
  test("retains valid category-specific ratings with normalized timestamps", () => {
    expect(parseRecentRaceRows([{
      subsession_id: 123,
      category_id: 2,
      session_start_time: "2026-01-02T03:04:05Z",
      oldi_rating: 1800,
      newi_rating: 1832,
    }])).toEqual([{
      eventId: "123:2",
      categoryId: 2,
      observedAt: "2026-01-02T03:04:05.000Z",
      change: 32,
      irating: 1832,
    }]);
  });

  test("excludes malformed, unknown-category, or missing-identity records", () => {
    expect(parseRecentRaceRows([
      { subsession_id: 1, category_id: 2, session_start_time: "not-a-date", oldi_rating: 1, newi_rating: 2 },
      { subsession_id: 2, category_id: 5, session_start_time: "2026-01-01T00:00:00Z", oldi_rating: 1, newi_rating: 2 },
      { category_id: 2, session_start_time: "2026-01-01T00:00:00Z", oldi_rating: 1, newi_rating: 2 },
      null,
    ])).toEqual([]);
  });
});
