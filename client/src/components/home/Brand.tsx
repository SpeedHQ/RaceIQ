import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import type { GameStats } from "./types";

export function GameBrandLogo({ gameId, className = "w-5 h-5" }: { gameId: string; className?: string }) {
  if (gameId === "fm-2023") return <img src="/forza-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "f1-2025") return <img src="/f1-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "acc") return <img src="/acc-logo.png" alt="" className={`object-contain ${className}`} />;
  return <span className="game-brand-accent text-xs font-black">{gameId === "iracing" ? "iR" : "ACE"}</span>;
}

export function GameBrandHeader({ gameId, gameDisplayName }: { gameId: string; gameDisplayName: string | null }) {
  return (
    <div data-game-brand={gameId} className="game-brand-panel relative overflow-hidden rounded-lg border p-5">
      <div className="game-brand-glow absolute -top-10 -right-10 w-[160px] h-[160px] rounded-full opacity-15 pointer-events-none" />
      <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] opacity-60" />
      <div className="absolute inset-0 overflow-hidden opacity-[0.05] pointer-events-none">
        <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
        <div className="game-brand-speed-line game-brand-line-50 absolute top-[55%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
        <div className="game-brand-speed-line game-brand-line-60 absolute top-[80%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
      </div>
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="game-brand-icon w-9 h-9 rounded-md border flex items-center justify-center shrink-0">
            <GameBrandLogo gameId={gameId} className="w-6 h-6" />
          </div>
          <div className="text-base font-bold text-app-text/90">{gameDisplayName ?? gameId}</div>
        </div>
      </div>
    </div>
  );
}

type GameKey = keyof GameStats;

const BRAND_CARDS: ReadonlyArray<{
  key: GameKey;
  gameId: string;
  route: "/fm23" | "/f125" | "/acc" | "/ac-evo" | "/iracing";
  name: string;
  linePositions: [string, string, string];
}> = [
  { key: "fm", gameId: "fm-2023", route: "/fm23", name: "Forza Motorsport", linePositions: ["top-[18%]", "top-[45%]", "top-[72%]"] },
  { key: "f1", gameId: "f1-2025", route: "/f125", name: "F1 2025", linePositions: ["top-[20%]", "top-[50%]", "top-[75%]"] },
  { key: "acc", gameId: "acc", route: "/acc", name: "Assetto Corsa Competizione", linePositions: ["top-[20%]", "top-[50%]", "top-[75%]"] },
  { key: "acEvo", gameId: "ac-evo", route: "/ac-evo", name: "Assetto Corsa Evo", linePositions: ["top-[20%]", "top-[50%]", "top-[75%]"] },
  { key: "iracing", gameId: "iracing", route: "/iracing", name: "iRacing", linePositions: ["top-[20%]", "top-[50%]", "top-[75%]"] },
];

function GameBrandCard({ game, stats }: { game: (typeof BRAND_CARDS)[number]; stats: GameStats[GameKey] }) {
  const [lineOne, lineTwo, lineThree] = game.linePositions;
  return (
    <Link
      to={game.route}
      data-game-brand={game.gameId}
      className="game-brand-panel game-brand-card group relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02] @3xl/workspace:flex-1"
    >
      <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
      <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
      <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
        <div className={`game-brand-speed-line game-brand-line-30 absolute ${lineOne} -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]`} />
        <div className={`game-brand-speed-line game-brand-line-50 absolute ${lineTwo} -left-[10%] w-[120%] h-px -rotate-[3deg]`} />
        <div className={`game-brand-speed-line game-brand-line-60 absolute ${lineThree} -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]`} />
      </div>
      <div className="relative flex items-center gap-2.5 mb-3.5">
        <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
          <GameBrandLogo gameId={game.gameId} />
        </div>
        <span className="text-sm font-bold text-app-text/90">{game.name}</span>
      </div>
      <div className="relative flex gap-5">
        <div>
          <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
          <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{stats.laps}</div>
        </div>
        <div>
          <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
          <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{stats.time}</div>
        </div>
      </div>
    </Link>
  );
}

export function GameBrandCards({ gameStats, hiddenGames }: { gameStats: GameStats; hiddenGames: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 @3xl/workspace:flex">
      {BRAND_CARDS.map((game) => (hiddenGames.includes(game.gameId) ? null : <GameBrandCard key={game.gameId} game={game} stats={gameStats[game.key]} />))}
    </div>
  );
}
