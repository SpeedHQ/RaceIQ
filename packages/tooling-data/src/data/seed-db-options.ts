import type { GameId } from "@raceiq/shared/games/ids";

export const SEED_MARKER = "raceiq-demo-seed-v1";
export const PROFILE_NAME = "RaceIQ Demo Driver";
export const DEFAULT_GAMES: GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "ams2", "lmu"];
export const LMU_MULTIPLAYER_FIXTURE_PARTS = [
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part01",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part02",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part03",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part04",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part05",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part06",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part07",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part08",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part09",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part10",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part11",
] as const;
export const LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS = [
  "packages/game-lmu/test/fixtures/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part1",
  "packages/game-lmu/test/fixtures/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part2",
] as const;
export const FIXTURES: Record<GameId, string[]> = {
  "fm-2023": [
    "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
    "test/artifacts/sessions/fm-2023-with-pitting.bin.gz",
  ],
  "f1-2025": ["test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz"],
  acc: ["test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz"],
  "ac-evo": ["test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz"],
  iracing: ["test/artifacts/sessions/iracing-road-america-gt3.bin.gz"],
  ams2: ["test/artifacts/sessions/ams2-race-pit-stop.bin.gz"],
  lmu: [...LMU_MULTIPLAYER_FIXTURE_PARTS],
};

export type SeedOptions = {
  clean: boolean;
  reset: boolean;
  force: boolean;
  legacyRecordings: boolean;
  games: GameId[];
  fixtures?: string[];
  excludedFixtures: string[];
};

function parseGames(value: string | undefined): GameId[] {
  let requestedGames: string[] = DEFAULT_GAMES;
  if (value) requestedGames = value.split(",");
  const games = requestedGames.filter((game): game is GameId => DEFAULT_GAMES.includes(game as GameId));

  if (games.length === 0) {
    throw new Error(`--games must include at least one of ${DEFAULT_GAMES.join(",")}`);
  }

  return games;
}

function parseFixtures(value: string | undefined, games: GameId[]): string[] | undefined {
  if (value === undefined) return undefined;

  if (games.length !== 1 || !value) {
    throw new Error("--fixtures requires one --games value and comma-separated recording paths");
  }

  return value.split(",");
}

function parseExcludedFixtures(fixtures: string[]): string[] {
  const knownFixtures = Object.values(FIXTURES).flat();

  if (fixtures.some((fixture) => !fixture || !knownFixtures.includes(fixture))) {
    throw new Error("--exclude-fixture requires a known seed fixture path");
  }

  return fixtures;
}

export function parseOptions(argv = process.argv): SeedOptions {
  let clean = false;
  let reset = false;
  let force = false;
  let legacyRecordings = false;
  let inlineGames: string | undefined;
  let separateGames: string | undefined;
  let fixturePaths: string | undefined;
  const excludedPaths: string[] = [];

  for (const [index, argument] of argv.entries()) {
    const equalsIndex = argument.indexOf("=");
    let option = argument;
    let value = "";
    if (equalsIndex !== -1) {
      option = argument.slice(0, equalsIndex + 1);
      value = argument.slice(equalsIndex + 1);
    }

    switch (option) {
      case "--clean":
        clean = true;
        break;
      case "--reset":
        reset = true;
        break;
      case "--force":
        force = true;
        break;
      case "--legacy-recordings":
        legacyRecordings = true;
        break;
      case "--games":
        separateGames ??= argv[index + 1];
        break;
      case "--games=":
        inlineGames ??= value;
        break;
      case "--fixtures=":
        fixturePaths ??= value;
        break;
      case "--exclude-fixture=":
        excludedPaths.push(value);
        break;
    }
  }

  const games = parseGames(inlineGames ?? separateGames);
  const fixtures = parseFixtures(fixturePaths, games);
  const excludedFixtures = parseExcludedFixtures(excludedPaths);

  return { clean, reset, force, legacyRecordings, games, fixtures, excludedFixtures };
}
