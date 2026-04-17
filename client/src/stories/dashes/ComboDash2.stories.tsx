import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import { ComboDash2 } from "../../components/dashes/ComboDash2";
import { fakeForzaPacket, generateFakeSessionLaps } from "../fakeData";

const MAX_LAPS = 100;

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

interface Args {
  lapCount: number;
}

function wrap({ lapCount }: Args) {
  const laps = generateFakeSessionLaps(lapCount);
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100%", height: "100vh", background: "#000" }}>
        {withRouter(
          <ComboDash2
            rawPacket={fakeForzaPacket}
            allLaps={laps}
            sessionLaps={laps}
          />,
        )}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<Args> = {
  title: "Dashes/Combo/Combo Dash 2",
  parameters: { layout: "fullscreen" },
  argTypes: {
    lapCount: {
      name: "Laps",
      control: { type: "range", min: 1, max: MAX_LAPS, step: 1 },
    },
  },
  args: {
    lapCount: 10,
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Default: Story = {
  render: (args) => wrap(args),
};

export const NoData: Story = {
  render: () => (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      <ComboDash2 rawPacket={null} allLaps={[]} sessionLaps={[]} />
    </div>
  ),
};

export const Tablet: Story = {
  render: (args) => wrap(args),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
