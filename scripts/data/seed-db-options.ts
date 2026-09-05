import type { GameId } from "../../shared/games/ids";

export const SEED_MARKER = "raceiq-demo-seed-v1";
export const PROFILE_NAME = "RaceIQ Demo Driver";
export const DEFAULT_GAMES: GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"];
export const FIXTURES: Record<GameId, string[]> = {
  "fm-2023": ["test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"],
  "f1-2025": ["test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz"],
  acc: ["test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz"],
  "ac-evo": ["test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz"],
  iracing: ["test/artifacts/sessions/iracing-road-america-gt3.bin.gz"],
};

export type SeedOptions = { clean: boolean; reset: boolean; force: boolean; games: GameId[] };

export function parseOptions(argv = process.argv): SeedOptions {
  const clean = argv.includes("--clean");
  const reset = argv.includes("--reset");
  const force = argv.includes("--force");
  const gamesArg = argv.find((arg) => arg.startsWith("--games="))?.slice("--games=".length)
    ?? (argv.includes("--games") ? argv[argv.indexOf("--games") + 1] : undefined);
  const games = (gamesArg ? gamesArg.split(",") : DEFAULT_GAMES).filter((game): game is GameId => DEFAULT_GAMES.includes(game as GameId));
  if (games.length === 0) throw new Error("--games must include at least one of fm-2023,f1-2025,acc,ac-evo,iracing");
  return { clean, reset, force, games };
}
