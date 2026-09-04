import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { fmTrackCatalog } from "../../shared/racing/tracks/catalogs/fm";
import { getF1Tracks } from "../../shared/racing/tracks/catalogs/f1";
import { getAccTracks } from "../../shared/racing/tracks/catalogs/acc";
import { getAcEvoTracks } from "../../shared/racing/tracks/catalogs/ac-evo";
import { getAllIRacingTracks } from "../../shared/racing/tracks/catalogs/iracing";
import { getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import type { Point } from "../../shared/racing/tracks/geometry/types";

const GAME_META: Record<GameId, { label: string; tag: string }> = {
  "fm-2023": { label: "Forza Motorsport", tag: "FM" },
  "f1-2025": { label: "F1 2025", tag: "F1 25" },
  acc: { label: "Assetto Corsa Competizione", tag: "ACC" },
  "ac-evo": { label: "Assetto Corsa EVO", tag: "AC EVO" },
  iracing: { label: "iRacing", tag: "iRacing" },
};

type MapKind = "inline-svg" | "remote-svg" | "none";

export interface MarketingTrackRecord {
  key: string;
  gameId: GameId;
  gameLabel: string;
  gameTag: string;
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  category?: string;
  lapCount: number;
  setupCount: number;
  mapSrc: string | null;
  mapKind: MapKind;
}

export interface MarketingTrackWallFixture {
  schemaVersion: 1;
  synthetic: true;
  games: Array<{ gameId: GameId; label: string; tag: string; count: number }>;
  tracks: MarketingTrackRecord[];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function downsample(points: Point[], maxPoints = 96): Point[] {
  if (points.length <= maxPoints) return points;
  const result: Point[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    result.push(points[Math.floor((index * (points.length - 1)) / (maxPoints - 1))]);
  }
  return result;
}

function outlineDataUrl(points: Point[]): string {
  const sampled = downsample(points);
  const minX = Math.min(...sampled.map((point) => point.x));
  const maxX = Math.max(...sampled.map((point) => point.x));
  const minY = Math.min(...sampled.map((point) => point.z));
  const maxY = Math.max(...sampled.map((point) => point.z));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(288 / width, 128 / height);
  const offsetX = 160 - ((minX + maxX) * scale) / 2;
  const offsetY = 80 - ((minY + maxY) * scale) / 2;
  const coordinates = sampled.map((point) => `${(point.x * scale + offsetX).toFixed(2)},${(point.z * scale + offsetY).toFixed(2)}`);
  const start = coordinates[0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><polyline points="${coordinates.join(" ")}" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${start.split(",")[0]}" cy="${start.split(",")[1]}" r="3" fill="#22d3ee"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function record(gameId: GameId, ordinal: number, info: { name: string; location: string; country: string; variant: string; lengthKm: number; category?: string; commonTrackName?: string; mapUrl?: string }): MarketingTrackRecord {
  const meta = GAME_META[gameId];
  const key = `${gameId}:${ordinal}`;
  const outline = getTrackOutlineByOrdinal(ordinal, gameId, info.commonTrackName);
  const mapSrc = outline ? outlineDataUrl(outline) : info.mapUrl || null;
  return {
    key,
    gameId,
    gameLabel: meta.label,
    gameTag: meta.tag,
    ordinal,
    name: info.name,
    location: info.location,
    country: info.country,
    variant: info.variant,
    lengthKm: info.lengthKm,
    ...(info.category ? { category: info.category } : {}),
    lapCount: 3 + (fnv1a(key) % 146),
    setupCount: (fnv1a(key) >>> 8) % 13,
    mapSrc,
    mapKind: outline ? "inline-svg" : info.mapUrl ? "remote-svg" : "none",
  };
}

function gameTracks(gameId: GameId): MarketingTrackRecord[] {
  const tracks = gameId === "fm-2023"
    ? Array.from(fmTrackCatalog, ([ordinal, info]) => record(gameId, ordinal, info))
    : gameId === "f1-2025"
      ? Array.from(getF1Tracks(), ([ordinal, info]) => record(gameId, ordinal, info))
      : gameId === "acc"
        ? Array.from(getAccTracks(), ([ordinal, info]) => record(gameId, ordinal, { ...info, location: "", country: "", lengthKm: 0 }))
        : gameId === "ac-evo"
          ? Array.from(getAcEvoTracks(), ([ordinal, info]) => record(gameId, ordinal, { ...info, location: "", country: "", lengthKm: 0 }))
          : getAllIRacingTracks().map((info) => record(gameId, info.ordinal, info));
  return tracks.sort((a, b) => a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant) || a.ordinal - b.ordinal);
}

export function buildMarketingTrackWallFixture(): MarketingTrackWallFixture {
  const perGame = KNOWN_GAME_IDS.map((gameId) => ({ gameId, tracks: gameTracks(gameId) }));
  const tracks = perGame.flatMap(({ gameId, tracks: rows }) => rows.map((track, index) => ({ track, normalized: (index + 0.5) / rows.length, rank: KNOWN_GAME_IDS.indexOf(gameId) })));
  tracks.sort((a, b) => a.normalized - b.normalized || a.rank - b.rank);
  return {
    schemaVersion: 1,
    synthetic: true,
    games: perGame.map(({ gameId, tracks: rows }) => ({ gameId, label: GAME_META[gameId].label, tag: GAME_META[gameId].tag, count: rows.length })),
    tracks: tracks.map(({ track }) => track),
  };
}

export async function writeMarketingTrackWallFixture(outputPath = "client/src/stories/marketing/track-wall.generated.json"): Promise<MarketingTrackWallFixture> {
  const fixture = buildMarketingTrackWallFixture();
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

if (import.meta.main) {
  const fixture = await writeMarketingTrackWallFixture();
  console.log(`Wrote ${fixture.tracks.length} layouts: ${fixture.games.map((game) => `${game.tag} ${game.count}`).join(", ")}`);
}
