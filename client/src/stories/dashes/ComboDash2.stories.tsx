import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import { ComboDash2 } from "../../components/dashes/ComboDash2";
import { fakeForzaPacket, fakeSessionLaps } from "../fakeData";

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

function wrap() {
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100%", height: "100vh", background: "#000" }}>
        {withRouter(
          <ComboDash2
            rawPacket={fakeForzaPacket}
            allLaps={fakeSessionLaps}
            sessionLaps={fakeSessionLaps}
          />,
        )}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof ComboDash2> = {
  title: "Dashes/Combo/Combo Dash 2",
  component: ComboDash2,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ComboDash2>;

export const Default: Story = {
  render: () => wrap(),
};

export const Tablet: Story = {
  render: () => wrap(),
  globals: { viewport: { value: "ipadLandscape", isRotated: false } },
};
