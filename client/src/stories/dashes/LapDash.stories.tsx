import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import { LapDash } from "../../components/dashes/LapDash";
import { fakeForzaDisplayPacket, fakeSectors } from "../fakeData";
import type { DisplayPacket } from "../../lib/convert-packet";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

function withRouter(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

function wrap(overrides?: Partial<DisplayPacket>) {
  const packet = { ...fakeForzaDisplayPacket, ...(overrides ?? {}) } as DisplayPacket;
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
        {withRouter(
          <LapDash packet={packet} sectors={fakeSectors} />,
        )}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof LapDash> = {
  title: "Dashes/LapDash",
  component: LapDash,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LapDash>;

export const Default: Story = { render: () => wrap() };
export const UnderBest: Story = {
  render: () => wrap({ LapNumber: 6, CurrentLap: 45.2, LastLap: 91.88, BestLap: 92.341 }),
};
export const OverBest: Story = {
  render: () => wrap({ LapNumber: 6, CurrentLap: 45.2, LastLap: 93.512, BestLap: 92.341 }),
};
export const NoBestYet: Story = {
  render: () => wrap({ LapNumber: 1, CurrentLap: 12.4, LastLap: 0, BestLap: 0 }),
};
export const Tablet: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadMini", isRotated: false } },
};
