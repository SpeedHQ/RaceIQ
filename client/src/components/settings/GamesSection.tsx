import { getAllGames } from "@shared/games/registry";
import { useSettings, useSaveSettings } from "../../hooks/queries";

export function GamesSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];
  const games = getAllGames();

  function toggle(gameId: string) {
    const next = hiddenGames.includes(gameId) ? hiddenGames.filter((id) => id !== gameId) : [...hiddenGames, gameId];
    saveSettings.mutate({ hiddenGames: next });
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">Games</h2>
      <p className="text-sm text-app-text-muted mb-4">Choose which games appear in the top navigation and on the home page.</p>
      <div className="space-y-2 max-w-sm">
        {games.map((game) => {
          const visible = !hiddenGames.includes(game.id);
          return (
            <button
              key={game.id}
              onClick={() => toggle(game.id)}
              className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-all ${
                visible ? "border-app-accent/30 bg-app-accent/5" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
              }`}
            >
              <span className={`text-sm font-medium ${visible ? "text-app-text" : "text-app-text-muted"}`}>{game.displayName}</span>
              {/* Toggle pill */}
              <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${visible ? "bg-app-accent" : "bg-app-border"}`}>
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${visible ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
