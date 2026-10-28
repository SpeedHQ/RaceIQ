import type { Meta, StoryObj } from "@storybook/react";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { ComponentType } from "react";
import { QueryClient } from "@tanstack/react-query";
import { AccLiveDashboard } from "../components/acc/AccLiveDashboard";
import { gameStore } from "../stores/game";
import { DEFAULT_DISPLAY_SETTINGS, telemetryStore } from "../stores/telemetry";
import { fakeAccSemanticFixture, fakeFuelOnlyPit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const storyLaps = fakeSessionLaps.filter((lap) => lap.lapNumber < 8).map((lap) => ({ ...lap, sessionId: 3, carId: "301" }));
function storyPlan(name: string, carId = "301"): RacePlan {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const evidence: StintSummary = {
    id: "fixture-stint", sessionId: 3, driverKey: "local-player", ordinal: 1, status: "completed", gameId: "acc",
    trackId: "7", carId, pi: null, compounds: ["DHF", "DHF", "DHF", "DHF"],
    compatibility: { fuelSemanticVersion: "fixture-v1", tireSemanticVersions: ["fixture-v1", "fixture-v1", "fixture-v1", "fixture-v1"], virtualEnergySemanticVersion: null, setupKey: null, conditions: { weather: null, airTemperatureC: null, trackTemperatureC: null } },
    startedAt: timestamp, endedAt: timestamp, firstLapNumber: 1, lastLapNumber: 10, boundary: { reason: "pit", confidence: "observed" }, completedLaps: 10,
    fuel: { value: 3, unit: "L/lap", eligibleLaps: 10, source: "history", provisional: false, unavailableReason: null },
    tires: [0, 1, 2, 3].map(() => ({ value: 0.001, unit: "wearFraction/lap" as const, eligibleLaps: 10, source: "history" as const, provisional: false, unavailableReason: null })) as StintSummary["tires"],
    measuredFuelUsed: 30, fuelUnit: "L", fuelCoverage: "complete", averageLapSeconds: 100, paceLaps: 10, exclusions: [], algorithmVersion: "fixture", revision: 1,
  };
  const approaching = name === "approaching";
  const stints: RacePlan["stints"] = [
    { endLap: approaching ? 9 : 12, startFuel: name === "shortfall" ? 15 : 38.2, compounds: ["DHF", "DHF", "DHF", "DHF"], sourceSessionId: 3, sourceStintId: evidence.id, evidence },
    { endLap: 20, startFuel: name === "shortfall" ? 15 : 38.2, compounds: ["DHF", "DHF", "DHF", "DHF"], sourceSessionId: 3, sourceStintId: evidence.id, evidence },
  ];
  return {
    id: name.toLowerCase().replaceAll(" ", "-"), name, gameId: "acc", carId, trackId: "7", pi: null,
    totalLaps: 20, raceLength: { mode: "laps" }, fuelUnit: "L", notes: "", generation: { fuelCapacity: 120, fuelReserve: 5, energyReserveFraction: 0 },
    createdAt: timestamp, updatedAt: timestamp, stints,
  };
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "acc"], storyLaps);
queryClient.setQueryData(["track-name", "7", "acc"], "Spa-Francorchamps");
queryClient.setQueryData(["car-name", "301", "acc"], "Lamborghini Huracan GT3");
queryClient.setQueryData(["acc-car-class", "301"], "GT3");
queryClient.setQueryData(["settings"], DEFAULT_DISPLAY_SETTINGS);


function StoryDecorator({ story, scenario }: { story: ComponentType; scenario: string | undefined }) {
  queryClient.setQueryData(["race-plans", "active"], { plans: [] });
  const plan = scenario === "unmatched" ? storyPlan("Other combo", "different-car") : scenario && scenario !== "baseline" ? storyPlan(scenario) : null;
  if (plan) queryClient.setQueryData(["race-plans", "active"], { plans: [plan] });
  const { schema, frame, view } = fakeAccSemanticFixture;
  const storyView: typeof view = scenario === "shortfall" ? {
    ...view,
    fuel: { ...view.fuel, amount: 8, capacity: 120 },
    statusBySemanticId: { ...view.statusBySemanticId, "fuel.fuel": { resolution: "ok", freshness: "fresh" } },
  } : view;
  telemetryStore.setState((prev) => ({
    ...prev,
    connected: true,
    telemetrySchema: schema,
    telemetryFrame: frame,
    telemetryView: storyView,
    sectors: fakeSectors,
    pit: fakeFuelOnlyPit,
    sessionLaps: storyLaps,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    serverStatus: {
      udpPps: 60,
      telemetryPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "acc", name: "Assetto Corsa Competizione" },
      currentSession: { id: 3, carId: "301", trackId: "7" },
    },
  }));
  gameStore.setState({ gameId: "acc" });
  return <LiveDashboardStoryFrame queryClient={queryClient} story={story} activePlans={plan ? [plan] : []} />;
}

const meta: Meta<typeof AccLiveDashboard> = {
  title: "Dashboards/AccLiveDashboard",
  component: AccLiveDashboard,
  decorators: [(Story, context) => <StoryDecorator story={Story} scenario={context.parameters.raceStrategyScenario as string | undefined} />],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof AccLiveDashboard>;

export const VisualContract: Story = { parameters: { raceStrategyScenario: "baseline" } };
export const SelectedStrategy: Story = { parameters: { raceStrategyScenario: "selected" } };
export const ApproachingStop: Story = { parameters: { raceStrategyScenario: "approaching" } };
export const FuelShortfall: Story = { parameters: { raceStrategyScenario: "shortfall" } };
export const UnmatchedComboFallback: Story = { parameters: { raceStrategyScenario: "unmatched" } };

