import { describe, expect, test } from "bun:test";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { selectionIncludesMotec } from "../../src/components/sessions/helpers";

const sessions: SessionMeta[] = [
  { id: 1, carOrdinal: 1, trackOrdinal: 1, createdAt: "2026-01-01", source: "motec" },
  { id: 2, carOrdinal: 1, trackOrdinal: 1, createdAt: "2026-01-02", source: undefined },
];
const laps: LapMeta[] = [
  { id: 11, sessionId: 1, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2026-01-01" },
  { id: 22, sessionId: 2, lapNumber: 1, lapTime: 91, isValid: true, createdAt: "2026-01-02" },
];

describe("Sessions MoTeC export selection", () => {
  test("detects selected MoTeC lap and direct session", () => {
    expect(selectionIncludesMotec({ lapIds: [11] }, sessions, laps)).toBe(true);
    expect(selectionIncludesMotec({ sessionIds: [1] }, sessions, laps)).toBe(true);
  });

  test("does not detect BIN-only or unknown selections", () => {
    expect(selectionIncludesMotec({ lapIds: [22] }, sessions, laps)).toBe(false);
    expect(selectionIncludesMotec({ lapIds: [999], sessionIds: [999] }, sessions, laps)).toBe(false);
  });
});
