import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { LiveTestDashboard } from "../components/tunes/LiveTestDashboard";
import { useTelemetryStore } from "../stores/telemetry";
import { fakeAccSemanticFixture, fakeSectors, fakeSessionLaps } from "./fakeData";
import { fakeTuneIssues } from "./setupEngineerFakeLap";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

// Simple oval outline so the track position panel has something to draw.
// NOTE: AnalyseTrackMap's Point type is { x, z } (not { x, y }) — using `y`
// makes minZ/maxZ NaN and the track renders as nothing (black panel).
const fakeOutline = Array.from({ length: 64 }, (_, i) => {
  const t = (i / 64) * Math.PI * 2;
  return { x: Math.cos(t) * 400, z: Math.sin(t) * 200 };
});
queryClient.setQueryData(["track-outline", 7, "acc"], fakeOutline);
queryClient.setQueryData(["track-boundaries", 7, "acc"], null);

function StoryDecorator({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const { schema, frame, view } = fakeAccSemanticFixture;
    useTelemetryStore.setState({
      connected: true,
      telemetrySchema: schema,
      telemetryFrame: frame,
      telemetryView: view,
      sectors: fakeSectors,
      sessionLaps: fakeSessionLaps,
      isRaceOn: true,
      lapIssuesFeed: [
        {
          lapId: 10,
          lapNumber: 4,
          issues: fakeTuneIssues,
          eligibility: {
            status: "eligible",
            policyId: "transient-event",
            policyVersion: "1",
            confidence: { level: "high", score: 1 },
            reasons: [],
            evidenceIds: [],
          },
        },
      ],
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "hidden", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof LiveTestDashboard> = {
  title: "Dashboards/Experiments/LiveTestDashboard",
  component: LiveTestDashboard,
  decorators: [
    (Story) => (
      <StoryDecorator>
        <Story />
      </StoryDecorator>
    ),
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LiveTestDashboard>;

export const Default: Story = {
  args: { gameId: "acc", trackOrdinal: 7 },
};
