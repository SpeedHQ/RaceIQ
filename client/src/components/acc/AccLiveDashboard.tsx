import { tryGetGame } from "@shared/games/registry";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../../shared/games/ids";
import { useCarName, useTirePressureOptimal } from "../../hooks/catalog-queries";
import { useTrackName } from "../../hooks/track-queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { LapTimeChart } from "../LapTimeChart";
import { NoDataView } from "../NoDataView";
import { RaceInfo } from "../RaceInfo";
import { RecordedLaps } from "../RecordedLaps";
import { PitEstimate } from "../telemetry/PitEstimate";
import { TireGrid } from "../telemetry/TireGrid";

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function AccLiveDashboard({ gameId = "acc" }: { gameId?: GameId }) {
  const view = useTelemetryStore((s) => s.telemetryView);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const sectors = useTelemetryStore((s) => s.sectors);
  const pit = useTelemetryStore((s) => s.pit);
  const { data: trackName } = useTrackName(view?.identity.trackOrdinal);
  const { data: carName } = useCarName(view?.identity.carOrdinal);
  const pressureOptimal = useTirePressureOptimal(gameId, view?.identity.carOrdinal);

  if (!view || view.simulator !== gameId) {
    return (
      <div className="flex-1 flex flex-col">
        <NoDataView />
      </div>
    );
  }

  return (
    <div data-live-dashboard-layout className="grid h-auto flex-1 grid-cols-1 gap-0 @5xl/workspace:h-full @5xl/workspace:grid-cols-2">
      {/* Left column: Tires + Pit Window */}
      <div className="border-r border-app-border overflow-auto">
        {/* Tires */}
        <div className="p-3">
          <TireGrid
            fl={{ tempC: view.tires.temperatureC?.fl ?? 0, wear: view.tires.wear?.fl ?? 0, brakeTemp: view.tires.brakeTemperatureC?.fl, brakePadMm: view.tires.brakePadRemainingMm?.fl, pressure: view.tires.pressurePsi?.fl }}
            fr={{ tempC: view.tires.temperatureC?.fr ?? 0, wear: view.tires.wear?.fr ?? 0, brakeTemp: view.tires.brakeTemperatureC?.fr, brakePadMm: view.tires.brakePadRemainingMm?.fr, pressure: view.tires.pressurePsi?.fr }}
            rl={{ tempC: view.tires.temperatureC?.rl ?? 0, wear: view.tires.wear?.rl ?? 0, brakeTemp: view.tires.brakeTemperatureC?.rl, brakePadMm: view.tires.brakePadRemainingMm?.rl, pressure: view.tires.pressurePsi?.rl }}
            rr={{ tempC: view.tires.temperatureC?.rr ?? 0, wear: view.tires.wear?.rr ?? 0, brakeTemp: view.tires.brakeTemperatureC?.rr, brakePadMm: view.tires.brakePadRemainingMm?.rr, pressure: view.tires.pressurePsi?.rr }}
            healthThresholds={tryGetGame(gameId)?.tireHealthThresholds ?? { green: 0.85, yellow: 0.7 }}
            tempThresholds={{ blue: 70, orange: 100, red: 110 }}
            pressureOptimal={pressureOptimal}
            brakeTempThresholds={tryGetGame(gameId)?.brakeTempThresholds}
            compound={typeof view.tires.compound === "string" ? view.tires.compound : undefined}
          />
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_pit_window()}</h2>
          </div>
          <div className="p-3">
            <PitEstimate view={view} pit={pit} />
          </div>
        </div>
      </div>

      {/* Right column: Race (with sectors) + Charts + Recorded Laps */}
      <div data-live-dashboard-race className="overflow-auto flex flex-col">
        <RaceInfo view={view} sectors={sectors} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />

        <div className="shrink-0 h-[240px]">
          <LapTimeChart sessionLaps={sessionLaps} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <RecordedLaps laps={sessionLaps} />
        </div>
      </div>
    </div>
  );
}
