import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { filterSessions } from "@raceiq/sessions-page/ui";
import { validateSessionsSearch } from "@raceiq/sessions-page/contracts";

const names = { trackNames: { 1: "Silverstone" }, carNames: { 2: "Porsche" } };
const sessions: SessionMeta[] = [
  { id: 1, trackId: "1", carId: "2", createdAt: "2026-01-01", ownership: "mine", source: "motec", isFavorite: true, processing: { state: "ready", stage: null, error: null } },
  { id: 2, trackId: "1", carId: "2", createdAt: "2026-01-02", ownership: "others", source: undefined, processing: { state: "ready", stage: null, error: null } },
];

describe("sessions ownership tabs", () => {
  test("filters by persisted ownership rather than source", () => {
    expect(filterSessions(sessions, "", "mine", names).map((session) => session.id)).toEqual([1]);
    expect(filterSessions(sessions, "", "others", names).map((session) => session.id)).toEqual([2]);
  });

  test("keeps search filtering within ownership tab", () => {
    expect(filterSessions(sessions, "silverstone", "others", names).map((session) => session.id)).toEqual([2]);
  });
});

test("filters favourite sessions within ownership tab", () => {
  expect(filterSessions(sessions, "", "mine", names, true).map((session) => session.id)).toEqual([1]);
  expect(filterSessions(sessions, "", "others", names, true)).toEqual([]);
});

describe("sessions route search", () => {
  test("uses mine by default and maps legacy tabs to mine", () => {
    expect(validateSessionsSearch({})).toEqual({ tab: undefined });
    expect(validateSessionsSearch({ tab: "recorded" })).toEqual({ tab: "mine" });
    expect(validateSessionsSearch({ tab: "imported" })).toEqual({ tab: "mine" });
    expect(validateSessionsSearch({ tab: "others" })).toEqual({ tab: "others" });
  });
});
