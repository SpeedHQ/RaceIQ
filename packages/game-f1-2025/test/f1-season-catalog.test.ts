import { expect, test } from "bun:test";
import { getAllF1Cars, getF1CarName, hasF1CarOrdinal } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1TrackInfo, getF1TrackName, getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";

// EA Season 8 v1.2 appendix; IDs identify the cars, not the UDP header year.
const season2026Teams = [
  [476, "Mercedes 2026"],
  [477, "Ferrari 2026"],
  [478, "Red Bull Racing 2026"],
  [479, "Williams 2026"],
  [480, "Aston Martin 2026"],
  [481, "Alpine 2026"],
  [482, "Racing Bulls 2026"],
  [483, "Haas 2026"],
  [484, "McLaren 2026"],
  [485, "Audi 2026"],
  [486, "Cadillac 2026"],
  [489, "ART Grand Prix 2026"],
  [490, "Campos 2026"],
  [491, "Rodin Motorsport 2026"],
  [492, "AIX Racing 2026"],
  [493, "DAMS 2026"],
  [494, "Hitech 2026"],
  [495, "MP Motorsport 2026"],
  [496, "Prema 2026"],
  [497, "Trident 2026"],
  [498, "Van Amersfoort Racing 2026"],
  [499, "Invicta 2026"],
] as const;

test("2026 cars resolve wide team IDs without replacing existing 2025 identities", () => {
  const cars = getAllF1Cars();
  for (const [id, name] of season2026Teams) {
    expect(getF1CarName(id)).toBe(name);
    expect(hasF1CarOrdinal(id)).toBe(true);
    expect(cars.find((car) => car.id === String(id))?.name).toBe(name);
  }
  expect(getF1CarName(0)).toBe("Mercedes");
  expect(getF1CarName(9)).toBe("Sauber");
  expect(getF1CarName(41)).toBe("F1 World");
  expect(getF1CarName(487)).toBe("Team 487");
  expect(hasF1CarOrdinal(487)).toBe(false);
});

test("Madrid is discoverable under its native ID without a fabricated length or geometry alias", () => {
  expect(getF1TrackName(42)).toBe("Madrid");
  expect(getF1Tracks().has(42)).toBe(true);
  expect(getF1TrackInfo(42)).toMatchObject({
    name: "Madrid",
    country: "ESP",
    lengthKm: 0, // Existing catalog sentinel: consumers hide unknown lengths.
    commonTrackName: "",
  });
  expect(getF1TrackName(19)).toBe("Autodromo Hermanos Rodriguez");
  expect(getF1TrackInfo(19)?.lengthKm).toBe(4.304);
  expect(getF1TrackInfo(43)).toBeUndefined();
});

test("reverse circuits retain distinct identities rather than borrowing forward geometry", () => {
  for (const [id, name] of [
    [39, "Silverstone Circuit (Reverse)"],
    [40, "Red Bull Ring (Reverse)"],
    [41, "Circuit Zandvoort (Reverse)"],
  ] as const) {
    expect(getF1TrackName(id)).toBe(name);
    expect(getF1TrackInfo(id)).toMatchObject({ variant: "Reverse", lengthKm: 0, commonTrackName: "" });
  }
});
