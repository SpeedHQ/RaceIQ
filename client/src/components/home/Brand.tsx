import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import type { GameStats } from "./types";

export function GameBrandLogo({ gameId, className = "w-5 h-5" }: { gameId: string; className?: string }) {
  if (gameId === "fm-2023") return <img src="/forza-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "f1-2025") return <img src="/f1-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "acc" || gameId === "ac-evo") {
    const logoSrc = gameId === "acc" ? "/acc-logo.svg" : "/acevo-logo.svg";
    return (
      <span
        aria-hidden="true"
        className={`game-brand-accent bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] ${className}`}
        style={{ maskImage: `url(${logoSrc})`, WebkitMaskImage: `url(${logoSrc})` }}
      />
    );
  }
  if (gameId === "lmu") {
    return (
      <span
        aria-hidden="true"
        className={`game-brand-accent bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] ${className}`}
        style={{ maskImage: "url(/lmu-logo.svg)", WebkitMaskImage: "url(/lmu-logo.svg)" }}
      />
    );
  }
  const label = gameId === "iracing" ? "iR" : "ACE";
  return <span className="game-brand-accent text-xs font-black">{label}</span>;
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
          <div className="text-app-title font-bold text-app-text/90">{gameDisplayName ?? gameId}</div>
        </div>
      </div>
    </div>
  );
}

type GameKey = keyof GameStats;

const BRAND_CARDS: ReadonlyArray<{
  key: GameKey;
  gameId: string;
  route: "/fm23" | "/f125" | "/acc" | "/ac-evo" | "/iracing" | "/lmu";
  name: string;
  logoSrc: string;
}> = [
  { key: "fm", gameId: "fm-2023", route: "/fm23", name: "Forza Motorsport", logoSrc: "/forza-logo.svg" },
  { key: "f1", gameId: "f1-2025", route: "/f125", name: "F1 2025", logoSrc: "/f1-logo.svg" },
  { key: "acc", gameId: "acc", route: "/acc", name: "Assetto Corsa Competizione", logoSrc: "/acc-logo.svg" },
  { key: "acEvo", gameId: "ac-evo", route: "/ac-evo", name: "Assetto Corsa Evo", logoSrc: "/acevo-logo.svg" },
  { key: "iracing", gameId: "iracing", route: "/iracing", name: "iRacing", logoSrc: "/iracing-logo.svg" },
  { key: "lmu", gameId: "lmu", route: "/lmu", name: "Le Mans Ultimate", logoSrc: "/lmu-logo.svg" },
];

function GameBrandCard({ game, stats, loading, selected }: { game: (typeof BRAND_CARDS)[number]; stats: GameStats[GameKey]; loading: boolean; selected: boolean }) {
  return (
    <Link
      to={game.route}
      data-game-brand={game.gameId}
      aria-busy={loading}
      aria-current={selected ? "page" : undefined}
      className="game-brand-card group block w-52 min-w-42 max-w-full flex-none rounded-lg active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent"
    >
      <Card variant="gradient" className={`relative h-full min-w-0 flex-row items-center gap-1.5 overflow-hidden rounded-lg p-2 font-normal transition-colors duration-150 group-hover:border-app-border-hover motion-reduce:transition-none ${selected ? "border-app-accent" : ""}`}>
        <span className="sr-only">{game.name}</span>
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-2 inset-y-1 flex items-center [mask-image:linear-gradient(to_right,black_20%,transparent_62%)]">
          <img src={game.logoSrc} alt="" className="h-[90%] w-[90%] object-contain object-left" />
        </div>
        <div aria-hidden="true" className="h-14 w-18 shrink-0" />
        <dl className="relative z-10 grid min-w-0 flex-1 grid-cols-[minmax(max-content,1fr)_max-content] items-baseline gap-x-1 gap-y-1 text-right">
          <dt className="col-start-2 row-start-1 whitespace-nowrap text-app-compact font-normal text-app-text-muted">{m.label_laps()}</dt>
          <dd className="col-start-1 row-start-1 wrap-anywhere text-app-detail font-normal font-mono leading-snug tabular-nums text-app-text"><Skeleton loading={loading}>{stats.laps > 0 ? stats.laps : "—"}</Skeleton></dd>
          <dt className="col-start-2 row-start-2 whitespace-nowrap text-app-compact font-normal text-app-text-muted">{m.home_card_driven()}</dt>
          <dd className="col-start-1 row-start-2 wrap-anywhere text-app-detail font-normal font-mono leading-snug tabular-nums text-app-text"><Skeleton loading={loading}>{stats.laps > 0 ? stats.time : "—"}</Skeleton></dd>
        </dl>
      </Card>
    </Link>
  );
}

export function GameBrandCards({ gameStats, hiddenGames, loading = false, selectedGameId = null }: { gameStats: GameStats; hiddenGames: string[]; loading?: boolean; selectedGameId?: string | null }) {
  return (
    <div className="grid grid-cols-2 justify-items-center gap-2 md:grid-cols-3 xl:grid-cols-6" aria-busy={loading}>
      {BRAND_CARDS.map((game) => (hiddenGames.includes(game.gameId) && selectedGameId !== game.gameId ? null : <GameBrandCard key={game.gameId} game={game} stats={gameStats[game.key]} loading={loading} selected={selectedGameId === game.gameId} />))}
    </div>
  );
}
