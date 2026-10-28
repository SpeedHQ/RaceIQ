import { getAllGames } from "@raceiq/shared/games/registry"
import { m } from "@/paraglide/messages";
import { useSaveSettings, useSettings } from "../../hooks/settings";
import SwitchListGroup from "../shadcn-studio/switch/switch-18";
import { TireThresholdControls } from "./TireThresholdControls";

export function GamesSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];
  const games = getAllGames();

  function setVisible(gameId: string, visible: boolean) {
    const next = visible ? hiddenGames.filter((id) => id !== gameId) : [...hiddenGames, gameId];
    saveSettings.mutate({ hiddenGames: next });
  }

  return (
    <section>
      <h2 id="games-heading" className="text-lg font-semibold text-app-text mb-1">{m.label_games()}</h2>
      <p id="games-description" className="text-sm text-app-text-muted mb-4">{m.games_desc()}</p>
      <SwitchListGroup
        labelledBy="games-heading"
        describedBy="games-description"
        items={games.map((game) => ({
          id: game.id,
          label: game.displayName,
          checked: !hiddenGames.includes(game.id),
        }))}
        onCheckedChange={setVisible}
      />
      <div className="mt-6 space-y-3 border-t border-app-border pt-5">
        <h3 className="text-base font-semibold text-app-text">{m.threshold_games_title()}</h3>
        <TireThresholdControls />
      </div>
    </section>
  );
}
