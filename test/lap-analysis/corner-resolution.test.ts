import { describe, expect, test } from "bun:test";
import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { lapCornersFromSegments } from "../../server/tracks/corner-resolution";

const packet = (distance: number): TelemetryPacket => ({ DistanceTraveled: distance }) as TelemetryPacket;

describe("lapCornersFromSegments", () => {
  test("keeps separate official iRacing turn labels and scales fractions to lap metres", () => {
    const segments: NamedSegment[] = [
      { type: "straight", name: "S1", startFrac: 0, endFrac: 0.2 },
      { type: "corner", name: "T1", number: 1, startFrac: 0.2, endFrac: 0.3 },
      { type: "corner", name: "T2", number: 2, startFrac: 0.3, endFrac: 0.5 },
      { type: "straight", name: "S2", startFrac: 0.5, endFrac: 0.6 },
      { type: "corner", name: "T3", number: 3, startFrac: 0.6, endFrac: 0.75 },
      { type: "corner", name: "T4", number: 4, startFrac: 0.75, endFrac: 0.9 },
    ];

    expect(lapCornersFromSegments(segments, [packet(2_000), packet(3_000)])).toEqual([
      { index: 0, label: "T1", distanceStart: 200, distanceEnd: 300 },
      { index: 1, label: "T2", distanceStart: 300, distanceEnd: 500 },
      { index: 2, label: "T3", distanceStart: 600, distanceEnd: 750 },
      { index: 3, label: "T4", distanceStart: 750, distanceEnd: 900 },
    ]);
  });

  test("uses detector-style numbering when segments have no official numbers", () => {
    const segments: NamedSegment[] = [
      { type: "corner", name: "Hairpin", startFrac: 0.1, endFrac: 0.2 },
      { type: "corner", name: "Esses", startFrac: 0.4, endFrac: 0.6 },
    ];

    expect(lapCornersFromSegments(segments, [packet(0), packet(500)]).map((corner) => corner.label)).toEqual(["T1", "T2"]);
  });

  test("returns no segment corners without a usable lap distance", () => {
    const segments: NamedSegment[] = [
      { type: "corner", name: "T1", number: 1, startFrac: 0.1, endFrac: 0.2 },
    ];

    expect(lapCornersFromSegments(segments, [packet(100), packet(100)])).toEqual([]);
  });
});
