import { describe, expect, test } from "bun:test";
import { recordedLapValidity } from "../../server/lap-detection/recorded-validity";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function packet(fields: Partial<TelemetryPacket>): TelemetryPacket {
  return { gameId: "acc", ...fields } as TelemetryPacket;
}

describe("recordedLapValidity", () => {
  test("uses F1 currentLapInvalid signal when present", () => {
    expect(recordedLapValidity(packet({ gameId: "f1-2025", f1: { currentLapInvalid: 0 } as never }))).toBe(true);
    expect(recordedLapValidity(packet({ gameId: "f1-2025", f1: { currentLapInvalid: 1 } as never }))).toBe(false);
  });

  test("uses Kunos validity signal for ACC and AC Evo", () => {
    expect(recordedLapValidity(packet({ gameId: "acc", acc: { isValidLap: true } as never }))).toBe(true);
    expect(recordedLapValidity(packet({ gameId: "ac-evo", acc: { isValidLap: false } as never }))).toBe(false);
  });

  test("returns null when no supported signal is available", () => {
    expect(recordedLapValidity(undefined)).toBe(null);
    expect(recordedLapValidity(packet({ gameId: "fm-2023" }))).toBe(null);
    expect(recordedLapValidity(packet({ gameId: "f1-2025", f1: {} as never }))).toBe(null);
    expect(recordedLapValidity(packet({ gameId: "acc", acc: { isValidLap: null } as never }))).toBe(null);
  });
});
