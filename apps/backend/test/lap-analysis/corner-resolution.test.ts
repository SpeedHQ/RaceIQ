import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { trackCorners } from "@raceiq/backend-core/db/schema";
import { saveCorners } from "@raceiq/backend-core/db/track-queries";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { cornerMatchesId } from "../../src/mastra/tools/corner-metrics";
import { lapCornersFromSegments, resolveLapCorners } from "../../src/tracks/corner-resolution";
const trackId = "corner-resolution-regression";
const gameId = "fm-2023" as const;
afterEach(async () => {
  await db.delete(trackCorners).where(and(eq(trackCorners.trackId, trackId), eq(trackCorners.gameId, gameId))).run();
});

const packet = (distance: number): TelemetryPacket => ({ DistanceTraveled: distance }) as TelemetryPacket;

function turnTelemetry(): TelemetryPacket[] {
  return Array.from({ length: 120 }, (_, index) => ({
    gameId,
    DistanceTraveled: 3520 + index * 2,
    VelocityX: index < 60 ? 60 : index < 100 ? 20 : 20 + index - 100,
    VelocityY: 0,
    VelocityZ: 0,
    Steer: index >= 60 && index < 100 ? 60 : 0,
  }) as TelemetryPacket);
}

describe("cornerMatchesId", () => {
  test("matches official zero-indexed T labels instead of ordinal indices", () => {
    const official = [{ index: 0, label: "T1" }, { index: 1, label: "T2" }];
    expect(official.filter((corner) => cornerMatchesId(corner, 1))).toEqual([official[0]]);
    expect(official.filter((corner) => cornerMatchesId(corner, 2))).toEqual([official[1]]);
  });

  test("matches grouped labels and one-indexed unlabeled stored or detected corners", () => {
    expect(cornerMatchesId({ index: 0, label: "T2,4" }, 4)).toBe(true);
    expect(cornerMatchesId({ index: 0, label: "T10-11" }, 11)).toBe(true);
    expect(cornerMatchesId({ index: 2, label: "Corner" }, 2)).toBe(true);
    expect(cornerMatchesId({ index: 1, label: "Turn One" }, 1)).toBe(true);
    expect(cornerMatchesId({ index: 3, label: "T2/4" }, 4)).toBe(true);
    expect(cornerMatchesId({ index: 1, label: "T1" }, 2)).toBe(false);
    expect(cornerMatchesId({ index: 1, label: "T1" }, 1)).toBe(true);
  });
});

describe("resolveLapCorners database precedence", () => {
  const storedCorner: Corner = {
    index: 1,
    label: "T1",
    distanceStart: 100,
    distanceEnd: 200,
  };

  test("manual stored corners retain authority over lap detection", async () => {
    await saveCorners(trackId, [storedCorner], gameId, false);
    expect(await resolveLapCorners(trackId, gameId, turnTelemetry(), { segments: [] })).toEqual([storedCorner]);
  });

  test("auto-detected stored rows do not shadow the selected lap's detection", async () => {
    await saveCorners(trackId, [{ ...storedCorner, distanceStart: 5000, distanceEnd: 5100 }], gameId, true);
    const [corner] = await resolveLapCorners(trackId, gameId, turnTelemetry(), { segments: [] });
    expect(corner).toMatchObject({ index: 1, label: "T1", minSpeedKph: 72 });
    expect(corner.distanceStart).toBeGreaterThan(0);
    expect(corner.distanceStart).toBeLessThan(200);
    expect(corner.distanceEnd).toBeGreaterThan(corner.distanceStart);
    expect(corner.distanceEnd).toBeLessThanOrEqual(238);
  });

  test("official segment definitions win over stored rows", async () => {
    await saveCorners(trackId, [storedCorner], gameId, false);
    const segments: NamedSegment[] = [
      { type: "corner", name: "Official T1", number: 1, startFrac: 0.2, endFrac: 0.3 },
    ];
    expect(await resolveLapCorners(trackId, gameId, [packet(1000), packet(2000)], { segments })).toEqual([
      { index: 0, label: "T1", distanceStart: 200, distanceEnd: 300 },
    ]);
  });
});

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
