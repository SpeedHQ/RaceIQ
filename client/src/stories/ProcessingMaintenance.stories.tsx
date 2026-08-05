import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { ProcessingMaintenance } from "../components/ProcessingMaintenance";
import { initialReprocessState, type ReprocessState } from "../lib/reprocess-state";
import { useTelemetryStore } from "../stores/telemetry";

type StoryState = {
  lapStale: number | null;
  lapReprocess: ReprocessState;
  raceStale: number | null;
  raceProgress: { done: number; total: number } | null;
  raceError: string | null;
};

function MaintenanceStory({ state }: { state: StoryState }) {
  useEffect(() => {
    const store = useTelemetryStore.getState();
    store.setStaleLapDetection(state.lapStale == null ? null : { sessionCount: state.lapStale, currentVersion: "lapdetector-v3" });
    useTelemetryStore.setState({ reprocessState: state.lapReprocess });
    store.setStaleRaceResults(state.raceStale == null ? null : { sessionCount: state.raceStale, currentVersion: "race-result-v2" });
    store.setRaceResultReprocessProgress(state.raceProgress);
    store.setRaceResultReprocessError(state.raceError);
    return () => {
      store.setStaleLapDetection(null);
      useTelemetryStore.setState({ reprocessState: initialReprocessState });
      store.setStaleRaceResults(null);
      store.setRaceResultReprocessProgress(null);
      store.setRaceResultReprocessError(null);
    };
  }, [state]);

  return (
    <main className="min-h-screen bg-app-bg p-8 text-app-text">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-lg font-semibold">Processing maintenance</h1>
        <p className="mb-5 text-sm text-app-text-muted">Versioned processing status and rerun controls.</p>
        <ProcessingMaintenance />
      </div>
    </main>
  );
}

const meta = {
  title: "Settings/Processing Maintenance",
  component: MaintenanceStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MaintenanceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {
  args: { state: { lapStale: null, lapReprocess: initialReprocessState, raceStale: null, raceProgress: null, raceError: null } },
};

export const RerunAvailable: Story = {
  args: { state: { lapStale: 4, lapReprocess: initialReprocessState, raceStale: 2, raceProgress: null, raceError: null } },
};

export const Running: Story = {
  args: { state: { lapStale: 4, lapReprocess: { status: "progressing", open: true, done: 2, total: 4 }, raceStale: 2, raceProgress: { done: 1, total: 2 }, raceError: null } },
};

export const Complete: Story = {
  args: { state: { lapStale: null, lapReprocess: { status: "success", open: true, done: 4, total: 4 }, raceStale: null, raceProgress: { done: 2, total: 2 }, raceError: null } },
};

export const RetryAfterError: Story = {
  args: {
    state: { lapStale: 4, lapReprocess: { status: "error", open: true, done: 0, total: 4, message: "reprocessing failed" }, raceStale: 2, raceProgress: null, raceError: "reconciliation failed" },
  },
};
