import { describe, expect, test } from "bun:test";
import { getGeoreferenceReference, getGeoreferenceTransform } from "../../server/db/georeference-queries";
import { assignLapGeoreference, resolveLapGeoreference } from "../../server/tracks/georeference";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const EARTH_RADIUS_M = 6_378_137;
const ORIGIN = { latitudeDeg: 35, longitudeDeg: -80, altitudeM: 120 };

type GeographicPoint = { latitudeDeg: number; longitudeDeg: number; altitudeM: number };

function packet(gameId: "iracing" | "fm-2023", x: number, z: number, geo?: GeographicPoint): TelemetryPacket {
  return {
    gameId,
    PositionX: x,
    PositionY: 0,
    PositionZ: z,
    iracing: geo ? { latitudeDeg: geo.latitudeDeg, longitudeDeg: geo.longitudeDeg, altitudeM: geo.altitudeM } : undefined,
  } as unknown as TelemetryPacket;
}

function referencePath(count = 80): GeographicPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index * Math.PI * 2) / (count - 1);
    const east = 650 * Math.cos(angle) + 90 * Math.cos(3 * angle);
    const north = 420 * Math.sin(angle) + 60 * Math.sin(2 * angle);
    return {
      latitudeDeg: ORIGIN.latitudeDeg + ((north / EARTH_RADIUS_M) * 180) / Math.PI,
      longitudeDeg: ORIGIN.longitudeDeg + ((east / (EARTH_RADIUS_M * Math.cos((ORIGIN.latitudeDeg * Math.PI) / 180))) * 180) / Math.PI,
      altitudeM: ORIGIN.altitudeM + 3 * Math.sin(angle),
    };
  });
}

function transformedLocalPath(path: readonly GeographicPoint[], count = 57): { packets: TelemetryPacket[]; expected: GeographicPoint[] } {
  const theta = 0.61;
  const scale = 1.7;
  const tx = 370;
  const tz = -215;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const packets: TelemetryPacket[] = [];
  const expected: GeographicPoint[] = [];
  for (let index = 0; index < count; index++) {
    const fraction = index / (count - 1);
    const sourceIndex = Math.pow(fraction, 1.7) * (path.length - 1);
    const before = Math.floor(sourceIndex);
    const after = Math.min(path.length - 1, before + 1);
    const blend = sourceIndex - before;
    const geo = {
      latitudeDeg: path[before]!.latitudeDeg + (path[after]!.latitudeDeg - path[before]!.latitudeDeg) * blend,
      longitudeDeg: path[before]!.longitudeDeg + (path[after]!.longitudeDeg - path[before]!.longitudeDeg) * blend,
      altitudeM: path[before]!.altitudeM + (path[after]!.altitudeM - path[before]!.altitudeM) * blend,
    };
    const east = (((geo.longitudeDeg - ORIGIN.longitudeDeg) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos((ORIGIN.latitudeDeg * Math.PI) / 180);
    const north = (((geo.latitudeDeg - ORIGIN.latitudeDeg) * Math.PI) / 180) * EARTH_RADIUS_M;
    const translatedEast = (east - tx) / scale;
    const translatedNorth = (north - tz) / scale;
    const rotatedEast = cos * translatedEast + sin * translatedNorth;
    const rotatedNorth = -sin * translatedEast + cos * translatedNorth;
    packets.push(packet("fm-2023", -rotatedEast, rotatedNorth));
    expected.push(geo);
  }
  return { packets, expected };
}

describe("georeference service", () => {
  test("seeds native reference, fits mirrored translated path, and persists transform", async () => {
    const slug = "test-georef-synthetic";
    const path = referencePath();
    const nativePackets = path.map((geo, index) => packet("iracing", index, index, geo));
    const native = await assignLapGeoreference({ canonicalSlug: slug, gameId: "iracing", trackOrdinal: 192, packets: nativePackets });
    expect(native?.kind).toBe("native");

    const local = transformedLocalPath(path);
    const before = local.packets.map((item) => [item.PositionX, item.PositionZ]);
    const assignment = await assignLapGeoreference({ canonicalSlug: slug, gameId: "fm-2023", trackOrdinal: 840, packets: local.packets });
    expect(assignment?.kind).toBe("derived");
    expect(assignment?.quality.rmseM).toBeLessThan(2);
    const derived = await resolveLapGeoreference({ canonicalSlug: slug, gameId: "fm-2023", trackOrdinal: 840, packets: local.packets });
    expect(derived?.metadata.kind).toBe("derived");
    expect(derived?.positions).toHaveLength(local.packets.length);
    expect(derived?.metadata.quality.rmseM).toBeLessThan(2);
    expect(derived?.positions[20]?.latitudeDeg).toBeCloseTo(local.expected[20]!.latitudeDeg, 5);
    expect(derived?.positions[20]?.longitudeDeg).toBeCloseTo(local.expected[20]!.longitudeDeg, 5);
    const second = await resolveLapGeoreference({ canonicalSlug: slug, gameId: "fm-2023", trackOrdinal: 840, packets: local.packets });
    expect(second?.metadata.quality.rmseM).toBe(derived?.metadata.quality.rmseM);
    expect(second?.positions[20]?.longitudeDeg).toBeCloseTo(derived?.positions[20]?.longitudeDeg ?? 0, 9);
    expect(local.packets.map((item) => [item.PositionX, item.PositionZ])).toEqual(before);
    const reference = await getGeoreferenceReference(slug, "iracing-track:192");
    expect(reference).not.toBeNull();
    expect(reference!.referencePath.length).toBeLessThanOrEqual(512);
    const transform = await getGeoreferenceTransform(slug, "fm-2023", 840, reference!.referenceVersion);
    expect(transform?.flipX).toBe(true);
  });

  test("omits unmatched and poor geometry", async () => {
    const unmatched = await resolveLapGeoreference({
      canonicalSlug: "never-learned",
      gameId: "fm-2023",
      trackOrdinal: 999,
      packets: referencePath(25).map((_, index) => packet("fm-2023", index, index)),
    });
    expect(unmatched).toBeNull();
    const poorSlug = "test-georef-poor";
    const poorReference = referencePath();
    await assignLapGeoreference({
      canonicalSlug: poorSlug,
      gameId: "iracing",
      trackOrdinal: 193,
      packets: poorReference.map((geo, index) => packet("iracing", index, index, geo)),
    });
    const poor = await assignLapGeoreference({
      canonicalSlug: poorSlug,
      gameId: "fm-2023",
      trackOrdinal: 999,
      packets: Array.from({ length: 30 }, (_, index) => packet("fm-2023", index * 10, 0)),
    });
    expect(poor).toBeNull();
  });
});
