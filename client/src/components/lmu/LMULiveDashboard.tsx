import { getGame } from "@shared/games/registry";
import { m } from "@/paraglide/messages";
import { useCarName } from "../../hooks/catalog-queries";
import { useTrackName } from "../../hooks/track-queries";
import { primaryTireTemperatureC } from "../../lib/live-telemetry-view";
import { useTelemetryStore } from "../../stores/telemetry";
import { LapTimeChart } from "../LapTimeChart";
import { NoDataView } from "../NoDataView";
import { RaceInfo } from "../RaceInfo";
import { RecordedLaps } from "../RecordedLaps";
import { PitEstimate } from "../telemetry/PitEstimate";
import { TireGrid } from "../telemetry/TireGrid";


export function LMULiveDashboard() {
  const lmuGame = getGame("lmu");
  const view = useTelemetryStore((state) => state.telemetryView);
  const sessionLaps = useTelemetryStore((state) => state.sessionLaps);
  const sectors = useTelemetryStore((state) => state.sectors);
  const pit = useTelemetryStore((state) => state.pit);
  const { data: trackName } = useTrackName(view?.identity.trackId);
  const { data: carName } = useCarName(view?.identity.carId);

  if (!view || view.simulator !== "lmu") {
    return (
      <div className="flex-1 flex flex-col">
        <NoDataView />
      </div>
    );
  }

  const wheelData = (corner: "fl" | "fr" | "rl" | "rr") => ({
    tempC: primaryTireTemperatureC(view.tires, corner) ?? 0,
    wear: view.tires.wear?.[corner] ?? 0,
    ...(view.tires.brakeTemperatureC ? { brakeTemp: view.tires.brakeTemperatureC[corner] } : {}),
    ...(view.tires.brakePadRemainingMm ? { brakePadMm: view.tires.brakePadRemainingMm[corner] } : {}),
    ...(view.tires.pressurePsi ? { pressure: view.tires.pressurePsi[corner] } : {}),
  });

  return (
    <div data-live-dashboard-layout data-live-dashboard-game="lmu" className="grid h-auto flex-1 grid-cols-1 gap-0 @5xl/workspace:h-full @5xl/workspace:grid-cols-2">
      <div className="border-r border-app-border overflow-auto">
        <div className="p-3">
          <TireGrid
            fl={wheelData("fl")}
            fr={wheelData("fr")}
            rl={wheelData("rl")}
            rr={wheelData("rr")}
            healthThresholds={lmuGame.tireHealthThresholds}
            tempThresholds={{ blue: 70, orange: 100, red: 110 }}
            brakeTempThresholds={lmuGame.brakeTempThresholds}
            compound={typeof view.tires.compound === "string" ? view.tires.compound : undefined}
            healthAvailable={view.tires.wear !== undefined}
          />
        </div>
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_pit_window()}</h2>
          </div>
          <div className="p-3">
            <PitEstimate view={view} pit={pit} />
          </div>
        </div>
      </div>

      <div data-live-dashboard-race className="overflow-auto flex flex-col">
        <RaceInfo
          view={view}
          sectors={sectors}
          trackName={trackName}
          carName={carName}
          showTrackMap={false}
          showSectors={true}
        />
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
