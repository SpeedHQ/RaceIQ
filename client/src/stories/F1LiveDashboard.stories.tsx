import type { Meta, StoryObj } from "@storybook/react";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import type { HistoricalBaseline, LiveStrategy, MetricRate, PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { ComponentType } from "react";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "@raceiq/shared/telemetry/resolver/versions";
import { TELEMETRY_DERIVATION_VERSION } from "@raceiq/telemetry-core/telemetry/derivations/builtins";
import { QueryClient } from "@tanstack/react-query";
import { F1LiveDashboard } from "../components/f1/F1LiveDashboard";
import { gameStore } from "../stores/game";
import { DEFAULT_DISPLAY_SETTINGS, telemetryStore } from "../stores/telemetry";
import { fakeF1SemanticFixture, fakePit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// Seed every query rendered by dashboard so standalone Storybook stays offline.
queryClient.setQueryData(["laps", "f1-2025"], fakeSessionLaps);
queryClient.setQueryData(["track-name", "7", "f1-2025"], "Bahrain International Circuit");
queryClient.setQueryData(["car-name", "42", "f1-2025"], "F1 2025");
queryClient.setQueryData(["settings"], DEFAULT_DISPLAY_SETTINGS);


const meta: Meta<typeof F1LiveDashboard> = {
  title: "Dashboards/F1LiveDashboard",
  component: F1LiveDashboard,
  decorators: [(Story, context) => <AdherenceStoryDecorator story={Story} scenario={context.parameters.raceStrategyScenario as string | undefined} />],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof F1LiveDashboard>;

export const VisualContract: Story = {};
const fixtureTimestamp = "2026-01-01T00:00:00.000Z";
const sessionId = 1;
const driverKey = "storybook-local-player";
const stintId = "storybook-f1-stint";
const semanticVersion = `f1-2025:${TELEMETRY_PARSER_VERSIONS["f1-2025"]}:${TELEMETRY_RESOLVER_VERSION}:${TELEMETRY_DERIVATION_VERSION}`;
const f1Compatibility = {
  fuelSemanticVersion: `${semanticVersion}:fuel-tankFraction-v1`,
  tireSemanticVersions: [0, 1, 2, 3].map(() => `${semanticVersion}:wear-fraction-worn-v1`) as StintSummary["compatibility"]["tireSemanticVersions"],
  virtualEnergySemanticVersion: null,
  setupKey: null,
  conditions: { weather: "0", airTemperatureC: 28, trackTemperatureC: 42 },
};

function metricRate(value: number, unit: MetricRate["unit"], source: MetricRate["source"] = "history"): MetricRate {
  return { value, unit, eligibleLaps: 6, source, provisional: false, unavailableReason: null };
}

function adherenceFixture(scenario: string) {
  const fuelOver = scenario === "over-fuel";
  const tireOver = scenario === "over-tire";
  const partial = scenario === "partial-evidence";
  const compounds: StintSummary["compounds"] = ["soft", "soft", "soft", "soft"];
  const totalLaps = scenario === "upcoming-window" ? 60 : 57;
  const evidence: StintSummary = {
    id: stintId, sessionId, driverKey, ordinal: 1, status: "active", gameId: "f1-2025", trackId: "7", carId: "42", pi: null,
    compounds, compatibility: f1Compatibility, startedAt: fixtureTimestamp, endedAt: null, firstLapNumber: 1, lastLapNumber: 8,
    boundary: { reason: "active", confidence: "observed" }, completedLaps: 8,
    fuel: metricRate(0.035, "tankFraction/lap"),
    tires: [0, 1, 2, 3].map(() => metricRate(0.02, "wearFraction/lap")) as StintSummary["tires"],
    measuredFuelUsed: 0.28, fuelUnit: "tankFraction", fuelCoverage: "complete", averageLapSeconds: 92, paceLaps: 8,
    exclusions: [], algorithmVersion: "fixture", revision: 1,
  };
  const baseline: HistoricalBaseline = {
    fuel: { ...evidence.fuel, source: "history" },
    tires: evidence.tires.map((rate) => ({ ...rate, source: "history" })) as StintSummary["tires"],
    evidence: ["fuel", "fl", "fr", "rl", "rr"].map((metric) => ({
      metric: metric as "fuel" | "fl" | "fr" | "rl" | "rr", sessionId, stintId, eligibleLaps: 6, endedAt: fixtureTimestamp,
    })),
    lastObservedAt: fixtureTimestamp, limitations: [], historyRevision: 1,
  };
  const estimates: PitEstimateRecord[] = Array.from({ length: 16 }, (_, index) => index + 2).map((lap) => {
    const serviceLap = scenario === "early-service" ? 5 : scenario === "late-service" ? 16 : null;
    const serviced = serviceLap !== null && lap >= serviceLap;
    const fuelRemaining = 0.75 - (lap - 2) * 0.035;
    const wear = serviced ? 0.03 + (lap - serviceLap!) * 0.02 : 0.05 + (lap - 2) * 0.02;
    return {
      id: `adherence-${scenario}-${lap}`, sessionId, driverKey, stintId, gameId: "f1-2025", trackId: "7", carId: "42", pi: null,
      compounds, observedAt: fixtureTimestamp, sourceOrder: { epochOrdinal: 0, sequence: lap },
      sourceCoordinate: { epoch: "storybook", domain: "session", milliseconds: lap * 92_000 },
      trigger: "lap-completed", pitInLaps: null, estimatedPitTime: { sessionElapsedSeconds: null }, limitedBy: null,
      tyreChangeSuggestion: "not-indicated", fuelChangeSuggestion: "not-indicated",
      fuel: metricRate(0.035, "tankFraction/lap"),
      tires: evidence.tires,
      sourceSnapshot: { fuelRemaining, fuelUnit: "tankFraction", wear: [wear, wear, wear, wear] as PitEstimateRecord["sourceSnapshot"]["wear"], lapId: lap },
      compatibility: f1Compatibility, baseline, algorithmVersion: "fixture",
    };
  });
  const fuel = partial
    ? { ...metricRate(0.035, "tankFraction/lap", null), value: null, eligibleLaps: 0, unavailableReason: "no-current-samples" }
    : metricRate(fuelOver ? 0.06 : 0.035, "tankFraction/lap", "current-stint");
  const tireRates = [0, 1, 2, 3].map((wheel) => partial && wheel === 3
    ? { ...metricRate(0.02, "wearFraction/lap", null), value: null, eligibleLaps: 0, unavailableReason: "no-current-samples" }
    : metricRate(tireOver && wheel === 0 ? 0.05 : 0.02, "wearFraction/lap", "current-stint")) as StintSummary["tires"];
  const strategy: LiveStrategy = { sessionId, driverKey, stintId, revision: 1, historyRevision: 1, fuel, tires: tireRates, baseline, persistence: "ok" };
  const currentStint: StintSummary = { ...evidence, fuel: metricRate(0.035, "tankFraction/lap", "current-stint"), tires: tireRates };
  const plan: RacePlan = {
    id: `storybook-${scenario}`, name: `F1 adherence ${scenario}`, gameId: "f1-2025", carId: "42", trackId: "7", pi: null,
    totalLaps, raceLength: { mode: "laps" }, fuelUnit: "tankFraction", notes: "",
    generation: { fuelCapacity: 1, fuelReserve: 0.05, energyReserveFraction: 0 },
    createdAt: fixtureTimestamp, updatedAt: fixtureTimestamp,
    stints: [
      { endLap: 12, startFuel: null, compounds, sourceSessionId: sessionId, sourceStintId: stintId, evidence },
      { endLap: totalLaps, startFuel: null, compounds, sourceSessionId: sessionId, sourceStintId: stintId, evidence },
    ],
  };
  return { plan, evidence, currentStint, baseline, estimates, strategy };
}

function AdherenceStoryDecorator({ story, scenario }: { story: ComponentType; scenario: string | undefined }) {
  const { schema, frame, view } = fakeF1SemanticFixture;
  const fixture = scenario ? adherenceFixture(scenario) : null;
  queryClient.setQueryData(["race-plans", "active"], { plans: fixture ? [fixture.plan] : [] });
  const lapNumber = scenario === "finish-window" ? 57 : scenario === "open-window" ? 34 : scenario === "late-service" ? 17 : 8;
  const cliffWear = 1 - getTireThresholds(DEFAULT_DISPLAY_SETTINGS.tireThresholdOverrides ?? {}, "f1-2025", "soft").cliffPct / 100;
  const currentFuel = 0.52;
  const currentWear = scenario === "overdue-window" || scenario === "over-tire" ? Math.min(0.99, cliffWear + 0.05)
    : scenario === "open-window" ? 0.2
      : scenario === "early-service" ? 0.09
        : scenario === "late-service" ? 0.05 : 0.16;
  const storyView: typeof view = fixture ? {
    ...view,
    sessionId,
    timing: { ...view.timing, lapNumber, lapFraction: 0.5 },
    fuel: { ...view.fuel, amount: currentFuel, capacity: 1 },
    tires: { ...view.tires, wear: { fl: currentWear, fr: scenario === "over-tire" ? 0.2 : currentWear, rl: scenario === "over-tire" ? 0.2 : currentWear, rr: scenario === "over-tire" ? 0.2 : currentWear } },
    statusBySemanticId: {
      ...view.statusBySemanticId,
      "timing.lap-fraction": { resolution: "ok", freshness: "fresh" },
      "fuel.fuel": { resolution: "ok", freshness: "fresh" },
    },
  } : view;
  const storyLaps = fixture ? Array.from({ length: Math.min(17, lapNumber - 1) }, (_, index) => ({ ...fakeSessionLaps[index % fakeSessionLaps.length]!, id: index + 1, lapNumber: index + 1 })) : fakeSessionLaps;
  telemetryStore.setState((prev) => ({
    ...prev,
    connected: true, telemetrySchema: schema, telemetryFrame: frame, telemetryView: storyView,
    sectors: fakeSectors, pit: fixture ? { ...fakePit, strategy: fixture.strategy } : fakePit, sessionLaps: storyLaps,
    isRaceOn: true, udpPps: 60, packetsPerSec: 60,
    serverStatus: {
      udpPps: 60, telemetryPps: 60, isRaceOn: true, droppedPackets: 0, udpPort: 5300,
      detectedGame: { id: "f1-2025", name: "F1 25" },
      currentSession: { id: 1, carId: "42", trackId: "7" },
    },
  }));
  gameStore.setState({ gameId: "f1-2025" });
  return <LiveDashboardStoryFrame
    queryClient={queryClient}
    story={story}
    activePlans={fixture ? [fixture.plan] : []}
    strategyEvidence={fixture ? { stints: [fixture.currentStint], estimates: fixture.estimates, baseline: fixture.baseline } : undefined}
  />;
}

export const AdherenceWithin: Story = { parameters: { raceStrategyScenario: "within" } };
export const FuelDoesNotChangePitWindow: Story = { parameters: { raceStrategyScenario: "over-fuel" } };
export const AdherenceTireOver: Story = { parameters: { raceStrategyScenario: "over-tire" } };
export const EarlyResourceService: Story = { parameters: { raceStrategyScenario: "early-service" } };
export const LateResourceService: Story = { parameters: { raceStrategyScenario: "late-service" } };
export const AdherencePartialEvidence: Story = { parameters: { raceStrategyScenario: "partial-evidence" } };
export const PitWindowUpcoming: Story = { parameters: { raceStrategyScenario: "upcoming-window" } };
export const PitWindowOpen: Story = { parameters: { raceStrategyScenario: "open-window" } };
export const PitWindowOverdue: Story = { parameters: { raceStrategyScenario: "overdue-window" } };
export const PitWindowFinish: Story = { parameters: { raceStrategyScenario: "finish-window" } };
